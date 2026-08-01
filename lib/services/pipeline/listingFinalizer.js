/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { storeListings } from '../storage/listingsStorage.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { saveListingText } from '../storage/listingTextStorage.js';
import { geocodeAddress } from '../geocoding/geoCodingService.js';
import { claimsForListing, geocodeAccuracyFor, recordClaims, resolveListingMatch } from '../listings/claims.js';
import { upsertListingAttributes } from '../listings/attributes.js';
import { structuredFeatureFlags } from '../scoring/hedonicFeatures.js';
import { enqueueRating } from './ratingQueue.js';
import {
  attachSourcesToListing,
  cancelAllWorkForListing,
  jobsForParsingQueue,
  sourceLinksForParsingQueue,
} from './sourceAudit.js';
import { CanonicalFacts, canonicalFilterReasons, primaryFilterReason, primaryFilterStage } from './listingFilters.js';
import { alreadyNotified, filterConfigHash, recordVerdict } from './terminalVerdict.js';

export class GeocodeDeferredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GeocodeDeferredError';
  }
}

/**
 * Finalize a live queue item: build the canonical listing from the LLM
 * extraction, geocode, decide visibility, resolve identity, store, and enqueue
 * durable rating work. Notifications are only enqueued after that rating stage.
 *
 * There is exactly one identity resolution here. There used to be four, each
 * with its own query and its own idea of which stored rows counted: a
 * `(job_id, hash)` replay lookup, an exact-source lookup through
 * listing_sources, a scan over historical rows whose source URLs predate the
 * dedupe-key column, and finally the five-tier `findDuplicate`. They ran in
 * sequence, so whichever fired first decided, and the three behaviours the
 * comments below describe were each implemented in a different one of them.
 * `resolveListingMatch` answers all four questions from one claim lookup and
 * reports which kind of evidence won, which is all the branching below needs.
 *
 * Geocoding now happens before resolution rather than after the replay check.
 * That costs nothing in practice: `geocodeAddress` answers from
 * homeserver_geocode_cache first, and a replay is by definition an address a
 * previous attempt already resolved and cached.
 *
 * @param {object} queue hydrated parsing_queue row
 * @param {object} llm validated LLM extraction
 * @param {{allowMissingCoordinates?: boolean, signal?: AbortSignal}} [options]
 * @returns {Promise<{status: string, listingId: string|null}>}
 */
export async function finalizeLive(queue, llm, { allowMissingCoordinates = false, signal } = {}) {
  signal?.throwIfAborted();
  const jobs = jobsForParsingQueue(queue.id);
  if (!jobs.length) throw new Error(`No job is interested in parse item '${queue.id}' any more`);

  const db = SqliteConnection.getConnection();
  const listing = buildCanonical(queue, llm);
  await attachCoordinates(listing, allowMissingCoordinates, signal);
  signal?.throwIfAborted();
  listing.attributes.features = structuredFeatureFlags(listing.attributes);
  listing.sourceIdentities = sourceIdentitiesForQueue(db, queue.id);
  listing.imageHashes = imageHashesForQueue(db, queue.id);
  listing.geocodeAccuracy = geocodeAccuracyFor(db, listing.address);

  // Identity first. Identity claims are never vetoed and never consult a
  // verdict, so asking for them before any filter runs is genuine dedupe before
  // work — and it is what stops one advert becoming three listings and three
  // messages when three searches find it.
  const claims = claimsForListing(listing);
  const identity = resolveListingMatch(db, listing, { claims, kinds: IDENTITY_KINDS });
  const listingId = identity ? absorbIntoExisting(db, listing, identity, claims) : null;

  // Then the verdict, once per interested job over the one shared extraction.
  const facts = new CanonicalFacts(listing);
  const verdicts = jobs.map((job) => {
    const reasons = canonicalFilterReasons(facts, job);
    return { job, reasons, reason: primaryFilterReason(reasons), stage: primaryFilterStage(reasons) };
  });
  const accepted = verdicts.filter((entry) => !entry.reason);

  if (listingId) {
    recordAllVerdicts(db, listingId, verdicts);
    attachSourcesToListing(queue.id, listingId, accepted.length ? null : verdicts[0].reason, 'final');
    if (!accepted.length) {
      cancelAllWorkForListing(listingId, verdicts[0].reason);
      return { status: 'duplicate', listingId };
    }
    enqueueRating(listingId, accepted[0].job.id, queue.provider, { notify: !alreadyNotified(db, listingId) });
    return { status: 'duplicate', listingId };
  }

  // No identity match. Resemblance evidence may still point at a stored row, and
  // now it can be judged against a verdict rather than a guess: a resemblance
  // match onto a listing some job accepts is only allowed when this capture is
  // itself accepted somewhere, so an inference can never silence a listing the
  // user can see.
  const resemblance = resolveListingMatch(db, listing, { claims, acceptedAnywhere: Boolean(accepted.length) });
  if (resemblance) {
    const mergedId = absorbIntoExisting(db, listing, resemblance, claims);
    recordAllVerdicts(db, mergedId, verdicts);
    attachSourcesToListing(queue.id, mergedId, accepted.length ? null : verdicts[0].reason, 'final');
    if (!accepted.length) {
      cancelAllWorkForListing(mergedId, verdicts[0].reason);
      return { status: 'duplicate', listingId: mergedId };
    }
    enqueueRating(mergedId, accepted[0].job.id, queue.provider, { notify: !alreadyNotified(db, mergedId) });
    return { status: 'duplicate', listingId: mergedId };
  }

  const [storedId] = storeListings(queue.provider, [listing]);
  if (!storedId) throw new Error('Canonical listing could not be stored');
  // Recorded immediately after the store and before the queue work, so a crash
  // in between leaves the replay claim behind for the retry to find.
  recordClaims(db, storedId, claims);
  recordAllVerdicts(db, storedId, verdicts);
  attachSourcesToListing(queue.id, storedId, accepted.length ? null : verdicts[0].reason);
  if (!accepted.length) {
    cancelAllWorkForListing(storedId, verdicts[0].reason);
    return { status: 'cancelled', listingId: storedId };
  }
  enqueueRating(storedId, accepted[0].job.id, queue.provider, { notify: true });
  return { status: 'completed', listingId: storedId };
}

/** Claim kinds that prove sameness rather than resemblance. */
const IDENTITY_KINDS = new Set(['cap', 'src', 'pid', 'url']);

/**
 * Write every job's answer about this listing.
 *
 * This is where the oscillation died. There used to be a `reviveFilteredListing`
 * branch: when a stored row was hidden and a fresh capture passed, it un-hid the
 * row globally and notified again — because one column had to serve three jobs
 * whose polygons disagreed, and the last writer won. Three jobs now write three
 * rows and nobody overwrites anybody.
 */
function recordAllVerdicts(db, listingId, verdicts) {
  for (const { job, reason, stage } of verdicts) {
    recordVerdict(db, {
      listingId,
      jobId: job.id,
      verdict: reason ? 'rejected' : 'accepted',
      reason,
      stage: stage ?? 'extraction',
      configHash: filterConfigHash(job),
    });
  }
}

/**
 * Fold this capture into the row it resolved to, and let that row own the
 * capture's claims so the next cross-post lands on it directly.
 */
function absorbIntoExisting(db, listing, match, claims) {
  const existing = match.listing;
  recordClaims(db, existing.id, claims);
  absorbInto(db, existing.id, listing);
  saveListingText(existing.id, listing.fullText, Date.now(), db);
  if (listing.attributes) upsertListingAttributes(db, existing.id, listing.attributes);
  return existing.id;
}

/**
 * Fold this capture into the surviving row: it proves the advert existed at
 * least as early as this discovery, that it is live now, and — because this is a
 * newer extraction of the same advert — what its facts currently are.
 *
 * Refreshing the facts used to be the job of a separate revive path that also
 * cleared the listing's verdict, because one verdict column had to serve three
 * jobs and the only way to let a passing capture through was to un-hide the row
 * for everyone. Verdicts are per job now, so the facts can be updated without
 * anybody's answer being overwritten.
 *
 * SQLite's `MIN()`/`MAX()` return NULL when *either* argument is NULL —
 * `sqlite3 :memory: "SELECT min(5,NULL)"` prints an empty string — so the merge
 * this is ported from wiped `created_at` on any row that had none. It needs a
 * COALESCE naming both sides.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} listingId surviving row
 * @param {object} capture freshly evaluated canonical listing
 */
function absorbInto(db, listingId, capture) {
  const createdAt = Number.isFinite(Number(capture.created_at)) ? Number(capture.created_at) : null;
  db.prepare(
    `UPDATE listings
     SET created_at = COALESCE(MIN(created_at, @createdAt), created_at, @createdAt),
         last_seen_at = @now,
         title = COALESCE(@title, title),
         address = COALESCE(@address, address),
         price = COALESCE(@price, price),
         size = COALESCE(@size, size),
         rooms = COALESCE(@rooms, rooms),
         latitude = COALESCE(@latitude, latitude),
         longitude = COALESCE(@longitude, longitude),
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

/**
 * Build the canonical listing from the capture and the validated LLM
 * extraction. Discovery-card facts are deliberately excluded: every semantic
 * field remains the validated LLM value, including null when evidence is
 * missing.
 *
 * @param {object} queue hydrated parsing_queue row
 * @param {object} llm validated LLM extraction
 * @returns {object} canonical listing with `attributes`
 */
function buildCanonical(queue, llm) {
  const structured = llm || {};
  const rent = structured.rent || {};
  const energy = structured.energy || {};
  const priceType = rent.price_type || 'unknown';
  const coldRent = rent.cold ?? null;
  const warmRent = rent.warm ?? null;
  const price = priceType === 'cold' ? coldRent : priceType === 'warm' ? warmRent : first(coldRent, warmRent);

  const furnishingStatus = structured.furnishing_status ?? 'unknown';
  const petsPolicy = structured.pets_policy ?? 'unknown';
  // The canonical attributes keep both the status and the boolean it implies, so
  // consumers and the stored history are unchanged. The difference is that the
  // boolean is now computed from one answer instead of being a second answer the
  // model had to keep consistent with the first.
  const amenities = amenityNames(structured.amenities, true);
  const amenitiesAbsent = amenityNames(structured.amenities, false);

  return {
    id: queue.source_hash,
    // The same value under the name the claim generator reads. `id` is what
    // storeListings writes into listings.hash and then overwrites with the row's
    // primary key, so it cannot be relied on afterwards.
    captureHash: queue.source_hash,
    jobId: queue.job_id,
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
    attributes: {
      coldRentEur: coldRent,
      warmRentEur: warmRent,
      serviceChargesEur: rent.service_charges ?? null,
      heatingCostsEur: rent.heating_costs ?? null,
      depositEur: rent.deposit ?? null,
      priceType,
      sizeSqm: structured.size_sqm ?? null,
      rooms: structured.rooms ?? null,
      floor: structured.floor ?? null,
      buildingYear: structured.building_year ?? null,
      propertyType: structured.property_type ?? null,
      energyClass: energy.class ?? null,
      petsAllowed: petsPolicy === 'allowed' ? true : petsPolicy === 'prohibited' ? false : null,
      petsPolicy,
      availableFrom: structured.available_from ?? 'unknown',
      availableUntil: structured.available_until ?? null,
      swap: structured.listing_type === 'swap',
      listingType: structured.listing_type || 'unknown',
      bedrooms: structured.bedrooms ?? null,
      bathrooms: structured.bathrooms ?? null,
      totalFloors: structured.total_floors ?? null,
      condition: structured.condition ?? null,
      furnished: furnishingStatus === 'full' ? true : furnishingStatus === 'none' ? false : null,
      furnishingStatus,
      smokingPolicy: structured.smoking_policy ?? 'unknown',
      leaseType:
        structured.lease_type ??
        (structured.listing_type === 'sublet' ? 'sublet' : structured.listing_type === 'swap' ? 'swap' : 'unknown'),
      offeredBy: structured.offered_by ?? 'unknown',
      minimumLeaseMonths: structured.minimum_lease_months ?? null,
      maximumOccupants: structured.maximum_occupants ?? null,
      heatingType: energy.heating_type ?? null,
      energyValueKwh: energy.value_kwh ?? null,
      amenities,
      amenitiesAbsent,
      addressComponents: structured.address_components ?? null,
      rentInclusions: Array.isArray(rent.included) ? rent.included : [],
      recurringCosts: {
        electricity: rent.electricity ?? null,
        internet: rent.internet ?? null,
        parking: rent.parking ?? null,
        furniture: rent.furniture ?? null,
        other: rent.other_recurring ?? null,
      },
      oneTimeBuyoutEur: rent.one_time_buyout ?? null,
      requirements: Array.isArray(structured.requirements) ? structured.requirements : [],
      conflicts: Array.isArray(structured.conflicts) ? structured.conflicts : [],
      comments: structured.comments ?? null,
      summary: structured.summary ?? null,
    },
  };
}

/**
 * Resolve the listing's position from its canonical address, and only from
 * that.
 *
 * The pre-extraction stage geocodes too, from an address scraped out of the page
 * or read off a search card. Inheriting that answer here let a district centroid
 * — precise enough for nothing, but stored all the same — decide a listing the
 * model had since given a house number for. `geocodeAddress` answers from the
 * cache first, so re-asking the question costs nothing whenever the address is
 * genuinely the same.
 */
async function attachCoordinates(listing, allowMissingCoordinates, signal) {
  if (!listing.address) return;
  signal?.throwIfAborted();
  const coords = await geocodeAddress(listing.address);
  signal?.throwIfAborted();
  if (coords == null) {
    if (!allowMissingCoordinates) throw new GeocodeDeferredError('Google geocoding is unavailable');
    return;
  }
  if (coords.lat !== -1 && coords.lng !== -1) {
    listing.latitude = coords.lat;
    listing.longitude = coords.lng;
  }
}

function first(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? null;
}

/**
 * Split the single amenity list back into the present/absent shape the stored
 * attributes and the hedonic features have always used.
 *
 * @param {{name: string, present: boolean}[]} amenities
 * @param {boolean} present which side to collect
 * @returns {string[]}
 */
function amenityNames(amenities, present) {
  if (!Array.isArray(amenities)) return [];
  return amenities.filter((amenity) => amenity?.present === present).map((amenity) => amenity.name);
}
