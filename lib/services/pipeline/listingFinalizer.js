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
import { enqueueRating } from './ratingQueue.js';
import {
  attachSourcesToListing,
  cancelAllWorkForListing,
  jobsForParsingQueue,
  sourceLinksForParsingQueue,
} from './sourceAudit.js';
import {
  CanonicalFacts,
  canonicalFilterReasons,
  primaryFilterReason,
  primaryFilterStage,
  primaryFilterTerm,
} from './listingFilters.js';
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
    return {
      job,
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
  for (const { job, reason, reasonTerm, stage } of verdicts) {
    recordVerdict(db, {
      listingId,
      jobId: job.id,
      verdict: reason ? 'rejected' : 'accepted',
      reason,
      reasonTerm,
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
/**
 * The one place the card filter is graded, and the one place a sampled refusal
 * is put back.
 *
 * A small fraction of card refusals are extracted anyway (see `enqueueDiscovery`)
 * because a card-stage refusal is otherwise unfalsifiable: the advert is never
 * fetched, so nothing can say whether the term that killed it was reading the
 * advert correctly. `WG` matching "3-Zi für Studenten-WG" is the standing
 * example.
 *
 * The comparison is recorded and then discarded as far as behaviour goes: every
 * verdict is overwritten with the card's own answer, whatever the extraction
 * concluded. So the sample cannot notify anything, cannot accept anything, and
 * cannot change a single stored verdict from what it would have been — it costs
 * one LLM call and produces one row to read. Letting a recovered advert through
 * would be a better product and a worse measurement, and this is a measurement.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} queue hydrated parse row
 * @param {{job: object, reasons: object[], reason: string|null, stage: string|null}[]} verdicts
 */
function recordCardFilterAudit(db, queue, verdicts) {
  const cardReasons = queue.card_rejection;
  if (!Array.isArray(cardReasons) || !cardReasons.length) return;
  const cardReason = primaryFilterReason(cardReasons);

  for (const entry of verdicts) {
    db.prepare(
      `INSERT INTO pipeline_audit_events (queue_id, stage, action, reason, payload_json, created_at)
       VALUES (?, 'card_audit', ?, ?, ?, ?)`,
    ).run(
      queue.id,
      // The whole finding, in the action, so it is countable without parsing JSON:
      // did the extraction refuse this advert for the same reason the card did?
      entry.reason === cardReason ? 'agreed' : entry.reason ? 'other_reason' : 'card_wrong',
      cardReason,
      JSON.stringify({ jobId: entry.job.id, card: cardReasons, canonical: entry.reasons }),
      Date.now(),
    );
    entry.reasons = cardReasons;
    entry.reason = cardReason;
    entry.reasonTerm = primaryFilterTerm(cardReasons);
    entry.stage = 'discovery';
  }
}

function buildCanonical(queue, llm) {
  const structured = llm || {};
  const rent = structured.rent || {};
  const warmRent = rent.warm ?? null;
  // Two identical figures mean the model could not separate them, so the one we
  // must not trust is the cold. Under the previous instruction — "state both,
  // subtracting the Nebenkosten from a stated Warmmiete" — this happened on 40%
  // of adverts that returned both, 262 listings, and of those the stored page
  // text says warm for 257 and cold for none: a Warmmiete was being filed as a
  // Kaltmiete, inflating the model target and passing maxPrice filters it should
  // have failed. The current instruction asks for each figure only where the
  // advert states it and the rate is 0 of 26, so this is a guard rather than a
  // workaround — and it is deterministic, unlike refusing the extraction, which
  // would buy a paid retry for an answer the model already gave.
  const coldRent = rent.cold != null && rent.cold === warmRent ? null : (rent.cold ?? null);
  // `price` and `priceType` describe one number together: the figure, and which
  // basis it is on. Both are read off the two stated rents, which is the only
  // source that cannot disagree with itself. Asking the model for the basis as a
  // third field and believing it over the numbers was its own bug — a stated
  // 'cold' with a null cold rent yielded no price at all and a `no_price` refusal.
  //
  // Warm is the fallback, not an equal alternative, and it is not converted:
  // warm ≥ cold, so filtering it against maxPrice can only refuse a flat that
  // might have passed, never admit one that should not. The market models decline
  // to score it rather than compare a warm ask against a cold fair price.
  const price = coldRent ?? warmRent;
  const priceType = coldRent != null ? 'cold' : warmRent != null ? 'warm' : 'unknown';

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
    // The name the claim generator reads. `id` is overwritten with the stored
    // row's primary key, so it cannot be relied on afterwards. No job travels
    // with it: the replay claim is job-agnostic, which is what lets two searches
    // finding one advert resolve to one listing.
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
    attributes: {
      coldRentEur: coldRent,
      warmRentEur: warmRent,
      depositEur: rent.deposit ?? null,
      priceType,
      floor: structured.floor ?? null,
      buildingYear: structured.building_year ?? null,
      propertyType: structured.property_type ?? null,
      energyClass: structured.energy_class ?? null,
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
      // `null` and `'unknown'` are both "no positive identification" and no
      // consumer branches on the difference, but they are not the same fact:
      // 'unknown' is the model having read the advert and been unable to tell,
      // null is an extraction that predates the field. Only rows migrated from
      // the old schema carry null.
      leaseType: structured.lease_type ?? null,
      offeredBy: structured.offered_by ?? null,
      amenities,
      amenitiesAbsent,
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
