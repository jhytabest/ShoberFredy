/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { storeListings } from '../storage/listingsStorage.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { saveListingText } from '../storage/listingTextStorage.js';
import { geocodeAddress } from '../geocoding/geoCodingService.js';
import { claimsForListing, geocodeAccuracyFor, recordClaims, resolveListingMatch } from '../listings/claims.js';
import { normalizeExtraction, attributesFromExtraction } from '../listings/standardizedFacts.js';
import { upsertListingAttributes } from '../listings/attributes.js';
import { enqueueNotification } from './notificationOutbox.js';
import { attachSourcesToListing, sourceIdentitiesForQueue, currentSourceForParse, recordListingAudit } from './sourceAudit.js';
import { decideListing } from './listingDecisionService.js';
import { cancelWork } from './workQueue.js';
import { getPipelineConfig } from '../storage/pipelineConfigStorage.js';
import { resolveListingMarket } from '../../shared/markets.js';
import logger from '../logger.js';

export async function finalizeLive(queue, llm, { signal } = {}) {
  signal?.throwIfAborted();
  const db = SqliteConnection.getConnection();
  const source = currentSourceForParse(queue.id, db);
  if (!source || source.historical) return cancelStaleCapture(queue.id, source);
  const s = normalizeExtraction(llm);
  const attributes = attributesFromExtraction(llm);
  const listing = {
    created_at: source.first_seen_at, provider: queue.provider, link: source.source_url,
    title: s.title ?? '', address: s.address ?? null, fullText: queue.capture.fullText ?? '',
    image: queue.capture.images?.[0]?.originalUrl ?? null,
    price: s.rent.cold ?? s.rent.warm ?? null, size: s.size_sqm ?? null, rooms: s.rooms ?? null, attributes,
  };
  if (listing.address) {
    try {
      const coords = await geocodeAddress(listing.address, { city: source.city, signal, audit: { queueId: queue.id } });
      if (coords && coords.lat !== -1 && coords.lng !== -1) {
        listing.latitude = coords.lat; listing.longitude = coords.lng;
        listing.geocodeAccuracy = geocodeAccuracyFor(db, listing.address, source.city);
      }
      listing.market = resolveListingMarket({ locality: coords?.locality, fallbackCity: source.city });
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`Geocoding left location unknown: ${error.message}`);
    }
  }
  listing.market ??= resolveListingMarket({ fallbackCity: source.city });
  listing.sourceIdentities = sourceIdentitiesForQueue(db, queue.id);
  listing.imageHashes = db.prepare(`SELECT DISTINCT content_hash FROM listing_images WHERE queue_id=? AND content_hash IS NOT NULL AND download_status IN ('stored','expired')`).all(queue.id).map((i) => i.content_hash);
  return db.transaction(() => {
    // Geocoding yields to discovery/capture. Fence every canonical write against
    // supersession or cancellation that occurred while that request was running.
    const current = currentSourceForParse(queue.id, db);
    if (!current || current.historical) return cancelStaleCapture(queue.id, current);
    const claims = claimsForListing(listing);
    const match = resolveListingMatch(db, listing, { claims });
    let id = match?.listing.id;
    if (id) {
      db.prepare(`UPDATE listings SET last_seen_at=?,title=?,address=?,price=?,size=?,rooms=?,latitude=?,longitude=?,market=?,link=?,image_url=?,provider=?,geocode_accuracy=?,representative_queue_id=? WHERE id=?`)
        .run(Date.now(), listing.title, listing.address, listing.price, listing.size, listing.rooms,
          listing.latitude ?? null, listing.longitude ?? null, listing.market, listing.link, listing.image, listing.provider, listing.geocodeAccuracy ?? null, queue.id, id);
      upsertListingAttributes(db, id, attributes);
      saveListingText(id, listing.fullText, Date.now(), db);
      recordListingAudit(id, { queueId: queue.id, stage: 'canonical_dedupe', action: 'merged', payload: { kind: match.kind, claim: match.claim, sharedImages: match.sharedImages, sourceId: source.id } });
    } else {
      [id] = storeListings(queue.provider, [listing]);
      db.prepare('UPDATE listings SET geocode_accuracy=?,representative_queue_id=? WHERE id=?').run(listing.geocodeAccuracy ?? null, queue.id, id);
    }
    recordClaims(db, id, claims);
    attachSourcesToListing(queue.id, id);
    const config = getPipelineConfig(db);
    const result = decideListing(db, { ...listing, id }, config);
    if (result.accepted) enqueueNotification(id, config);
    return { status: match ? 'duplicate' : 'completed', listingId: id };
  })();
}

function cancelStaleCapture(key, source) {
  cancelWork('parse', key, 'Capture is no longer current or source is historical', {
    code: source?.historical ? 'already_decided' : 'superseded',
  });
  return { status: 'cancelled' };
}
