/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getJob } from '../storage/jobStorage.js';
import { storeListings } from '../storage/listingsStorage.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { saveListingText } from '../storage/listingTextStorage.js';
import { geocodeAddress, hasUsableGeocode } from '../geocoding/geoCodingService.js';
import { addressKey } from '../geocoding/address.js';
import { claimsForListing, geocodeAccuracyFor, recordClaims, resolveListingMatch } from '../listings/claims.js';
import { upsertListingAttributes } from '../listings/attributes.js';
import { structuredFeatureFlags } from '../scoring/hedonicFeatures.js';
import { enqueueRating } from './ratingQueue.js';
import { attachSourcesToListing, cancelAllWorkForListing, sourceLinksForParsingQueue } from './sourceAudit.js';
import { postLlmFilterReasons, primaryFilterReason } from './listingFilters.js';

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
  const job = getJob(queue.job_id);
  if (!job) throw new Error(`Job '${queue.job_id}' no longer exists`);

  const db = SqliteConnection.getConnection();
  const listing = buildCanonical(queue, llm);
  await attachCoordinates(listing, job, allowMissingCoordinates, signal);
  signal?.throwIfAborted();
  listing.attributes.features = structuredFeatureFlags(listing.attributes);
  listing.filterReasons = postLlmFilterReasons(listing, job);
  listing.hidden_reason = primaryFilterReason(listing.filterReasons);
  listing.sourceIdentities = sourceIdentitiesForQueue(db, queue.id);
  listing.imageHashes = imageHashesForQueue(db, queue.id);
  listing.geocodeAccuracy = geocodeAccuracyFor(db, listing.address);

  const claims = claimsForListing(listing);
  const match = resolveListingMatch(db, listing, { claims });
  if (match) {
    signal?.throwIfAborted();
    return mergeIntoExisting(db, queue, job, listing, match, claims);
  }

  const [listingId] = storeListings(job.id, queue.provider, [listing]);
  if (!listingId) throw new Error('Canonical listing could not be stored');
  // Recorded immediately after the store and before the queue work, so a crash
  // in between leaves the replay claim behind for the retry to find.
  recordClaims(db, listingId, claims);
  attachSourcesToListing(queue.id, listingId, listing.hidden_reason);
  if (listing.hidden_reason) cancelAllWorkForListing(listingId, listing.hidden_reason);
  else {
    enqueueRating(listingId, job.id, queue.provider, { notify: true });
  }
  return { status: listing.hidden_reason ? 'cancelled' : 'completed', listingId };
}

/**
 * This capture belongs to a row that already exists. Which of the four
 * behaviours applies is decided by the kind of claim that matched and by the
 * stored row's own state — never by forking a second row, because the
 * notification outbox is keyed on the listing id and a fork is a second message.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} queue hydrated parsing_queue row
 * @param {object} job
 * @param {object} listing freshly evaluated canonical listing
 * @param {{listing: object, kind: string}} match resolved claim match
 * @param {{claim: string, kind: string}[]} claims
 * @returns {{status: string, listingId: string}}
 */
function mergeIntoExisting(db, queue, job, listing, match, claims) {
  const existing = match.listing;
  const hidden = Boolean(existing.hidden_reason);
  const userDeleted = Boolean(existing.manually_deleted) && !hidden;
  // Whatever happens below, the surviving row inherits this capture's claims, so
  // the next cross-post of the same flat resolves straight to it. Claims already
  // owned stay with their owner.
  recordClaims(db, existing.id, claims);

  if (match.kind === 'cap') {
    // Idempotent replay: a previous attempt stored this exact capture and died
    // before completing its queue item. Repeat everything after the store, and
    // take the stored row's verdict rather than this one's — the stored row may
    // have been hidden or deleted since, and that decision is newer than this
    // capture.
    absorbInto(db, existing.id, listing);
    if (existing.manually_deleted || hidden) {
      cancelAllWorkForListing(existing.id, existing.hidden_reason || 'Listing manually deleted');
    } else {
      enqueueRating(existing.id, job.id, queue.provider, { notify: true });
    }
    attachSourcesToListing(queue.id, existing.id, existing.hidden_reason);
    return {
      status: existing.manually_deleted || hidden ? 'cancelled' : 'completed',
      listingId: existing.id,
    };
  }

  if (userDeleted) {
    // A deletion the user made by hand outranks a fresh filter verdict. Attach
    // the capture and stop: nothing is revived and nothing is reactivated. This
    // check used to sit behind the one below, where `manually_deleted &&
    // !hidden_reason` could never reach it.
    attachSourcesToListing(queue.id, existing.id, null, 'final');
    return { status: 'duplicate', listingId: existing.id };
  }

  if (listing.hidden_reason || !hidden) {
    // Either the fresh verdict hides it too, or the stored row is already the
    // visible canonical one. Nothing to revive.
    absorbInto(db, existing.id, listing);
    attachSourcesToListing(queue.id, existing.id, listing.hidden_reason, 'final');
    return { status: 'duplicate', listingId: existing.id };
  }

  // The stored row is filter-hidden and this verdict passes. Reviving it keeps
  // the listing id stable; forking instead is how one wg-gesucht ad became four
  // listings and four Telegram messages, because a filter verdict can differ
  // between captures when the detail page carries evidence the card does not.
  // Only identity kinds can reach here — resolution never offers a hidden row on
  // resemblance evidence alone unless this capture is itself filtered out, and
  // then `listing.hidden_reason` is set and the branch above took it.
  reviveFilteredListing(db, existing, listing);
  enqueueRating(existing.id, job.id, queue.provider, { notify: true });
  attachSourcesToListing(queue.id, existing.id, null, 'final');
  return { status: 'completed', listingId: existing.id };
}

/**
 * Fold into the surviving row the two things this capture proves: that the ad
 * existed at least as early as this discovery, and that it is live now.
 *
 * SQLite's `MIN()`/`MAX()` return NULL when *either* argument is NULL —
 * `sqlite3 :memory: "SELECT min(5,NULL)"` prints an empty string — so the merge
 * this is ported from wiped `created_at` on any row that had none and reset
 * `is_active` to NULL rather than keeping the one value it had. Every one of them
 * needs a COALESCE naming both sides.
 *
 * Visibility is deliberately untouched: nothing here may unhide a row.
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
         is_active = COALESCE(MAX(is_active, 1), is_active, 1),
         inactive_at = NULL,
         inactive_reason = NULL
     WHERE id = @listingId`,
  ).run({ listingId, createdAt });
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

  const furnishingStatus = structured.furnishing_status ?? furnishingFromLegacy(structured.furnished);
  const petsPolicy = structured.pets_policy ?? petsFromLegacy(structured.pets_allowed);

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
      availability: structured.availability ?? 'unknown',
      availabilityPrecision: structured.availability_precision ?? 'unknown',
      availableFrom: structured.available_from ?? null,
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
      minimumLeaseMonths: structured.minimum_lease_months ?? null,
      maximumOccupants: structured.maximum_occupants ?? null,
      heatingType: energy.heating_type ?? null,
      energyValueKwh: energy.value_kwh ?? null,
      amenities: Array.isArray(structured.amenities) ? structured.amenities : [],
      amenitiesAbsent: Array.isArray(structured.amenities_absent) ? structured.amenities_absent : [],
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
 * Whether a previously stored row already holds the geocode for this exact
 * address. The LLM usually restates the address an earlier stage already
 * geocoded, and asking again only spends a lookup on an identical answer. An
 * expired coarse entry is deliberately not reusable, so it still gets the
 * retry that can upgrade it to a building-level match.
 *
 * @param {object|null|undefined} previous stored listing row
 * @param {string} address canonical LLM address
 * @returns {boolean}
 */
function reusableCoordinates(previous, address) {
  if (!previous?.address) return false;
  if (addressKey(previous.address) !== addressKey(address)) return false;
  if (previous.latitude == null || previous.longitude == null) return false;
  const lat = Number(previous.latitude);
  const lng = Number(previous.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === -1 || lng === -1) return false;
  return hasUsableGeocode(address);
}

async function attachCoordinates(listing, job, allowMissingCoordinates, signal, previous) {
  if (!listing.address) return;
  if (reusableCoordinates(previous, listing.address)) {
    listing.latitude = Number(previous.latitude);
    listing.longitude = Number(previous.longitude);
    return;
  }
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
 * Bring a filter-hidden row back into view under a fresh, passing verdict.
 *
 * {@link replaceCanonical} deliberately makes `hidden_reason` and
 * `manually_deleted` sticky, so an update can never quietly unhide something.
 * That is right for an in-place canonical refresh and wrong here: this path has
 * a complete new verdict for a listing whose only reason for being hidden was
 * an earlier filter pass. Clearing both is what keeps the ad on its original
 * row instead of forking a fresh one.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} existing stored row, filter-hidden
 * @param {object} candidate freshly evaluated canonical listing, not hidden
 */
function reviveFilteredListing(db, existing, candidate) {
  db.transaction(() => {
    db.prepare(
      `UPDATE listings
       SET title = ?, address = ?, price = ?, size = ?, rooms = ?,
           manually_deleted = 0, hidden_reason = NULL,
           latitude = ?, longitude = ?, filter_reasons_json = '[]', is_active = 1,
           inactive_at = NULL, inactive_reason = NULL
       WHERE id = ?`,
    ).run(
      candidate.title,
      candidate.address,
      candidate.price,
      candidate.size,
      candidate.rooms,
      candidate.latitude ?? null,
      candidate.longitude ?? null,
      existing.id,
    );
    saveListingText(existing.id, candidate.fullText, Date.now(), db);
    upsertListingAttributes(db, existing.id, candidate.attributes);
  })();
}

function first(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? null;
}

function furnishingFromLegacy(value) {
  return value === true ? 'full' : value === false ? 'none' : 'unknown';
}

function petsFromLegacy(value) {
  return value === true ? 'allowed' : value === false ? 'prohibited' : 'unknown';
}
