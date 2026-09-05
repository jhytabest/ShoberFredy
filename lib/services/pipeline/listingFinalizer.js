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
import { attachSourcesToListing, jobsForParsingQueue, sourceLinksForParsingQueue } from './sourceAudit.js';
import {
  CanonicalFacts,
  canonicalFilterReasons,
  primaryFilterReason,
  primaryFilterStage,
  primaryFilterTerm,
} from './listingFilters.js';
import { filterConfigHash, recordVerdict } from './terminalVerdict.js';
import { resolveListingMarket } from '../../shared/markets.js';

export class GeocodeDeferredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GeocodeDeferredError';
  }
}

export async function finalizeLive(queue, llm, { allowMissingCoordinates = false, signal } = {}) {
  signal?.throwIfAborted();
  const jobs = jobsForParsingQueue(queue.id);
  if (!jobs.length) throw new Error(`No job is interested in parse item '${queue.id}' any more`);

  const db = SqliteConnection.getConnection();
  const listing = buildCanonical(queue, llm);
  // Any job that wants this advert can anchor the geocode; they are searching
  // the same page, and the locality that comes back decides the market anyway.
  const anchorCity = jobs.find((job) => job.city)?.city ?? null;
  await attachCoordinates(listing, allowMissingCoordinates, signal, anchorCity);
  signal?.throwIfAborted();
  listing.market = resolveListingMarket({ locality: listing.geocodeLocality, fallbackCity: anchorCity });
  listing.sourceIdentities = sourceIdentitiesForQueue(db, queue.id);
  listing.imageHashes = imageHashesForQueue(db, queue.id);
  listing.geocodeAccuracy = geocodeAccuracyFor(db, listing.address, anchorCity);

  const claims = claimsForListing(listing);
  const identity = resolveListingMatch(db, listing, { claims, kinds: IDENTITY_KINDS });
  const listingId = identity ? absorbIntoExisting(db, listing, identity, claims) : null;

  const facts = new CanonicalFacts(listing);
  const verdicts = jobs.map((job) => {
    const reasons = canonicalFilterReasons(facts, job);
    return {
      job,
      facts,
      reasons,
      reason: primaryFilterReason(reasons),
      reasonTerm: primaryFilterTerm(reasons),
      stage: primaryFilterStage(reasons),
    };
  });
  recordCardFilterAudit(db, queue, verdicts);
  const accepted = verdicts.filter((entry) => !entry.reason);

  if (listingId) {
    recordAllVerdicts(db, listingId, verdicts);
    attachSourcesToListing(queue.id, listingId, accepted.length ? null : verdicts[0].reason, 'final');
    if (!accepted.length) {
      return { status: 'duplicate', listingId };
    }
    for (const entry of accepted) enqueueNotification(listingId, entry.job, queue.provider);
    return { status: 'duplicate', listingId };
  }

  const resemblance = resolveListingMatch(db, listing, { claims, acceptedAnywhere: Boolean(accepted.length) });
  if (resemblance) {
    const mergedId = absorbIntoExisting(db, listing, resemblance, claims);
    recordAllVerdicts(db, mergedId, verdicts);
    attachSourcesToListing(queue.id, mergedId, accepted.length ? null : verdicts[0].reason, 'final');
    if (!accepted.length) {
      return { status: 'duplicate', listingId: mergedId };
    }
    for (const entry of accepted) enqueueNotification(mergedId, entry.job, queue.provider);
    return { status: 'duplicate', listingId: mergedId };
  }

  const [storedId] = storeListings(queue.provider, [listing]);
  if (!storedId) throw new Error('Canonical listing could not be stored');
  recordClaims(db, storedId, claims);
  recordAllVerdicts(db, storedId, verdicts);
  attachSourcesToListing(queue.id, storedId, accepted.length ? null : verdicts[0].reason);
  if (!accepted.length) {
    return { status: 'cancelled', listingId: storedId };
  }
  for (const entry of accepted) enqueueNotification(storedId, entry.job, queue.provider);
  return { status: 'completed', listingId: storedId };
}

const IDENTITY_KINDS = new Set(['cap', 'src', 'pid', 'url']);

function recordAllVerdicts(db, listingId, verdicts) {
  for (const { job, facts, reasons, reason, reasonTerm, stage } of verdicts) {
    recordVerdict(db, {
      listingId,
      jobId: job.id,
      verdict: reason ? 'rejected' : 'accepted',
      reason,
      reasonTerm,
      stage: stage ?? 'extraction',
      configHash: filterConfigHash(job),
      reasons,
      facts,
    });
  }
}

function absorbIntoExisting(db, listing, match, claims) {
  const existing = match.listing;
  recordClaims(db, existing.id, claims);
  absorbInto(db, existing.id, listing);
  saveListingText(existing.id, listing.fullText, Date.now(), db);
  if (listing.attributes) upsertListingAttributes(db, existing.id, listing.attributes);
  return existing.id;
}

function absorbInto(db, listingId, capture) {
  const createdAt = Number.isFinite(Number(capture.created_at)) ? Number(capture.created_at) : null;
  db.prepare(
    `UPDATE listings
     SET created_at = COALESCE(MIN(created_at, @createdAt), created_at, @createdAt),
         last_seen_at = @now,
         title = @title,
         address = @address,
         price = @price,
         size = @size,
         rooms = @rooms,
         latitude = @latitude,
         longitude = @longitude,
         market = COALESCE(@market, market),
         state = 'active', state_reason = NULL, state_at = NULL
     WHERE id = @listingId`,
  ).run({
    listingId,
    createdAt,
    now: Date.now(),
    title: capture.title ?? null,
    address: capture.address ?? null,
    price: capture.price ?? null,
    size: capture.size ?? null,
    rooms: capture.rooms ?? null,
    latitude: capture.latitude ?? null,
    longitude: capture.longitude ?? null,
    market: capture.market ?? null,
  });
}

function sourceIdentitiesForQueue(db, queueId) {
  return db
    .prepare(
      `SELECT provider, source_key AS sourceKey, source_url AS sourceUrl
       FROM listing_sources
       WHERE parsing_queue_id = ?
       ORDER BY first_seen_at ASC`,
    )
    .all(queueId);
}

function imageHashesForQueue(db, queueId) {
  return db
    .prepare(
      `SELECT DISTINCT content_hash
       FROM listing_images
       WHERE queue_id = ? AND download_status = 'stored' AND content_hash IS NOT NULL`,
    )
    .all(queueId)
    .map((row) => row.content_hash);
}

function recordCardFilterAudit(db, queue, verdicts) {
  const cardReasons = queue.card_rejection;
  if (!Array.isArray(cardReasons) || !cardReasons.length) return;
  const cardReason = primaryFilterReason(cardReasons);

  for (const entry of verdicts) {
    if (queue.card_rejection_job_id && entry.job.id !== queue.card_rejection_job_id) continue;
    db.prepare(
      `INSERT INTO pipeline_audit_events (queue_id, stage, action, reason, payload_json, created_at)
       VALUES (?, 'card_audit', ?, ?, ?, ?)`,
    ).run(
      queue.id,
      entry.reason === cardReason ? 'agreed' : entry.reason ? 'other_reason' : 'card_wrong',
      cardReason,
      JSON.stringify({ jobId: entry.job.id, card: cardReasons, canonical: entry.reasons }),
      Date.now(),
    );
  }
}

function buildCanonical(queue, llm) {
  const structured = normalizeExtraction(llm);
  const rent = structured.rent || {};
  const warmRent = rent.warm ?? null;
  const coldRent = rent.cold ?? null;
  const price = coldRent ?? warmRent;
  return {
    id: queue.source_hash,
    captureHash: queue.source_hash,
    created_at: queue.discovered_at,
    provider: queue.provider,
    link: queue.capture.sourceUrl || queue.source_url,
    sourceUrls: sourceLinksForParsingQueue(queue.id),
    title: structured.title ?? '',
    address: structured.address ?? null,
    fullText: queue.capture.fullText || '',
    image: queue.capture.images?.[0]?.originalUrl || null,
    price,
    size: structured.size_sqm ?? null,
    rooms: structured.rooms ?? null,
    attributes: attributesFromExtraction(llm),
  };
}

async function attachCoordinates(listing, allowMissingCoordinates, signal, city) {
  if (!listing.address) return;
  signal?.throwIfAborted();
  const coords = await geocodeAddress(listing.address, { city });
  signal?.throwIfAborted();
  if (coords == null) {
    if (!allowMissingCoordinates) throw new GeocodeDeferredError('Google geocoding is unavailable');
    return;
  }
  if (coords.lat !== -1 && coords.lng !== -1) {
    listing.latitude = coords.lat;
    listing.longitude = coords.lng;
  }
  listing.geocodeLocality = coords.locality ?? null;
}
