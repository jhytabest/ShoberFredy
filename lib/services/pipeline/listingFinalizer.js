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
import { findDuplicate } from '../listings/dedupe.js';
import { structuredFeatureFlags } from '../scoring/hedonicFeatures.js';
import { enqueueRating } from './ratingQueue.js';
import {
  attachSourcesToListing,
  cancelAllWorkForListing,
  findOwnerListingForParsingQueue,
  sourceLinksForParsingQueue,
} from './sourceAudit.js';
import { postLlmFilterReasons, primaryFilterReason } from './listingFilters.js';

export class GeocodeDeferredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GeocodeDeferredError';
  }
}

/**
 * Finalize a live queue item: build the canonical listing from the LLM
 * extraction, geocode, decide visibility, dedupe, store, and enqueue durable
 * rating work. Notifications are only enqueued after that rating stage.
 *
 * Idempotent under retries: if a previous attempt already stored the listing
 * (crash between store and queue completion), the stored row is reused and
 * only the outbox enqueue (INSERT OR IGNORE) is repeated.
 *
 * @param {object} queue hydrated parsing_queue row
 * @param {object} llm validated LLM extraction
 * @param {{allowMissingCoordinates?: boolean}} [options]
 * @returns {Promise<{status: string, listingId: string|null}>}
 */
export async function finalizeLive(queue, llm, { allowMissingCoordinates = false, signal } = {}) {
  signal?.throwIfAborted();
  const job = getJob(queue.job_id);
  if (!job) throw new Error(`Job '${queue.job_id}' no longer exists`);

  const db = SqliteConnection.getConnection();
  const stored = db
    .prepare('SELECT * FROM listings WHERE job_id = ? AND hash = ?')
    .get(queue.job_id, queue.source_hash);
  if (stored) {
    // Replay everything after the store that a crashed attempt may have
    // skipped; both operations are idempotent.
    if (stored.manually_deleted || stored.hidden_reason) {
      cancelAllWorkForListing(stored.id, stored.hidden_reason || 'Listing manually deleted');
    } else {
      enqueueRating(stored.id, job.id, queue.provider, { notify: true });
    }
    attachSourcesToListing(queue.id, stored.id, stored.hidden_reason);
    return {
      status: stored.manually_deleted || stored.hidden_reason ? 'cancelled' : 'completed',
      listingId: stored.id,
    };
  }

  const listing = buildCanonical(queue, llm);
  await attachCoordinates(listing, job, allowMissingCoordinates, signal);
  signal?.throwIfAborted();
  listing.attributes.features = structuredFeatureFlags(listing.attributes);
  listing.filterReasons = postLlmFilterReasons(listing, job);
  listing.hidden_reason = primaryFilterReason(listing.filterReasons);

  // The same provider offer can be discovered by several jobs owned by one
  // user, and re-discovered on later runs. Its source identity is proof of
  // sameness, so it always resolves to the one canonical row — a second row for
  // an ad we have already stored is never correct.
  //
  // This used to fork whenever the stored row was hidden and the new evaluation
  // came out visible. Because a filter verdict can differ between captures (the
  // detail page carries evidence the card does not), one wg-gesucht ad forked
  // four times and sent four notifications. Reviving the stored row keeps the
  // listing id stable, and the notification outbox is keyed on that id, so the
  // second message cannot be produced in the first place.
  const exactSourceListing = findOwnerListingForParsingQueue(queue.id, queue.job_id);
  if (exactSourceListing) {
    const storedIsFilteredOut = Boolean(exactSourceListing.hidden_reason);
    const userDeleted = Boolean(exactSourceListing.manually_deleted) && !exactSourceListing.hidden_reason;
    if (listing.hidden_reason || !storedIsFilteredOut) {
      // Either the new verdict hides it too, or the stored row is already the
      // visible canonical one. Nothing to revive.
      attachSourcesToListing(queue.id, exactSourceListing.id, listing.hidden_reason, 'final');
      return { status: 'duplicate', listingId: exactSourceListing.id };
    }
    if (userDeleted) {
      // A deletion the user made by hand outranks a fresh filter verdict.
      attachSourcesToListing(queue.id, exactSourceListing.id, null, 'final');
      return { status: 'duplicate', listingId: exactSourceListing.id };
    }
    signal?.throwIfAborted();
    reviveFilteredListing(db, exactSourceListing, listing);
    enqueueRating(exactSourceListing.id, job.id, queue.provider, { notify: true });
    attachSourcesToListing(queue.id, exactSourceListing.id, null, 'final');
    return { status: 'completed', listingId: exactSourceListing.id };
  }

  if (!listing.hidden_reason) {
    listing.sourceIdentities = sourceIdentitiesForQueue(db, queue.id);
    listing.imageHashes = imageHashesForQueue(db, queue.id);
    const duplicate = findDuplicate(listing, { stage: 'final' });
    if (duplicate) {
      // Only the identity layers can return a hidden row, and when one does it
      // is the same ad resurfacing under a verdict that now passes. Revive it
      // rather than attaching this capture to a row nobody will ever see.
      if (duplicate.hidden_reason) {
        reviveFilteredListing(db, duplicate, listing);
        enqueueRating(duplicate.id, job.id, queue.provider, { notify: true });
        attachSourcesToListing(queue.id, duplicate.id, null, 'final');
        return { status: 'completed', listingId: duplicate.id };
      }
      attachSourcesToListing(queue.id, duplicate.id, null, 'final');
      return { status: 'duplicate', listingId: duplicate.id };
    }
  }

  const [listingId] = storeListings(job.id, queue.provider, [listing]);
  if (!listingId) throw new Error('Canonical listing could not be stored');
  attachSourcesToListing(queue.id, listingId, listing.hidden_reason);
  if (listing.hidden_reason) cancelAllWorkForListing(listingId, listing.hidden_reason);
  else {
    enqueueRating(listingId, job.id, queue.provider, { notify: true });
  }
  return { status: listing.hidden_reason ? 'cancelled' : 'completed', listingId };
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
    upsertAttributes(db, existing.id, candidate.attributes);
  })();
}

function upsertAttributes(db, listingId, a) {
  db.prepare(
    `INSERT INTO listing_attributes (
       listing_id, cold_rent_eur, warm_rent_eur, service_charges_eur, heating_costs_eur,
       deposit_eur, price_type, rooms, floor, building_year, property_type, energy_class,
       pets_allowed, available_from, swap, features_json, parsed_at, listing_type,
       bedrooms, bathrooms, total_floors, condition, furnished, heating_type,
       energy_value_kwh, amenities_json, availability, comments,
       address_json, availability_precision, available_until, furnishing_status,
       pets_policy, smoking_policy, lease_type, minimum_lease_months, maximum_occupants,
       amenities_absent_json, rent_inclusions_json, requirements_json, conflicts_json,
       recurring_costs_json, one_time_buyout_eur, summary
     ) VALUES (
       @listingId, @coldRentEur, @warmRentEur, @serviceChargesEur, @heatingCostsEur,
       @depositEur, @priceType, @rooms, @floor, @buildingYear, @propertyType, @energyClass,
       @petsAllowed, @availableFrom, @swap, @featuresJson, @parsedAt, @listingType,
       @bedrooms, @bathrooms, @totalFloors, @condition, @furnished, @heatingType,
       @energyValueKwh, @amenitiesJson, @availability, @comments,
       @addressJson, @availabilityPrecision, @availableUntil, @furnishingStatus,
       @petsPolicy, @smokingPolicy, @leaseType, @minimumLeaseMonths, @maximumOccupants,
       @amenitiesAbsentJson, @rentInclusionsJson, @requirementsJson, @conflictsJson,
       @recurringCostsJson, @oneTimeBuyoutEur, @summary
     )
     ON CONFLICT(listing_id) DO UPDATE SET
       cold_rent_eur=excluded.cold_rent_eur, warm_rent_eur=excluded.warm_rent_eur,
       service_charges_eur=excluded.service_charges_eur, heating_costs_eur=excluded.heating_costs_eur,
       deposit_eur=excluded.deposit_eur, price_type=excluded.price_type, rooms=excluded.rooms,
       floor=excluded.floor, building_year=excluded.building_year, property_type=excluded.property_type,
       energy_class=excluded.energy_class, pets_allowed=excluded.pets_allowed,
       available_from=excluded.available_from, swap=excluded.swap, features_json=excluded.features_json,
       parsed_at=excluded.parsed_at, listing_type=excluded.listing_type, bedrooms=excluded.bedrooms,
       bathrooms=excluded.bathrooms, total_floors=excluded.total_floors, condition=excluded.condition,
       furnished=excluded.furnished, heating_type=excluded.heating_type,
       energy_value_kwh=excluded.energy_value_kwh, amenities_json=excluded.amenities_json,
       availability=excluded.availability, comments=excluded.comments,
       address_json=excluded.address_json, availability_precision=excluded.availability_precision,
       available_until=excluded.available_until, furnishing_status=excluded.furnishing_status,
       pets_policy=excluded.pets_policy, smoking_policy=excluded.smoking_policy,
       lease_type=excluded.lease_type, minimum_lease_months=excluded.minimum_lease_months,
       maximum_occupants=excluded.maximum_occupants,
       amenities_absent_json=excluded.amenities_absent_json,
       rent_inclusions_json=excluded.rent_inclusions_json,
       requirements_json=excluded.requirements_json, conflicts_json=excluded.conflicts_json,
       recurring_costs_json=excluded.recurring_costs_json,
       one_time_buyout_eur=excluded.one_time_buyout_eur,
       summary=excluded.summary`,
  ).run(attributeParams(listingId, a));
}

function attributeParams(listingId, a) {
  return {
    listingId,
    coldRentEur: a.coldRentEur ?? null,
    warmRentEur: a.warmRentEur ?? null,
    serviceChargesEur: a.serviceChargesEur ?? null,
    heatingCostsEur: a.heatingCostsEur ?? null,
    depositEur: a.depositEur ?? null,
    priceType: a.priceType ?? null,
    rooms: a.rooms ?? null,
    floor: a.floor ?? null,
    buildingYear: a.buildingYear ?? null,
    propertyType: a.propertyType ?? null,
    energyClass: a.energyClass ?? null,
    petsAllowed: a.petsAllowed == null ? null : a.petsAllowed ? 1 : 0,
    availableFrom: a.availableFrom ?? null,
    swap: a.swap ? 1 : 0,
    featuresJson: JSON.stringify(a.features || {}),
    parsedAt: Date.now(),
    listingType: a.listingType ?? null,
    bedrooms: a.bedrooms ?? null,
    bathrooms: a.bathrooms ?? null,
    totalFloors: a.totalFloors ?? null,
    condition: a.condition ?? null,
    furnished: a.furnished == null ? null : a.furnished ? 1 : 0,
    heatingType: a.heatingType ?? null,
    energyValueKwh: a.energyValueKwh ?? null,
    amenitiesJson: JSON.stringify(a.amenities || []),
    availability: a.availability ?? null,
    comments: a.comments ?? null,
    summary: a.summary ?? null,
    addressJson: json(a.addressComponents),
    availabilityPrecision: a.availabilityPrecision ?? null,
    availableUntil: a.availableUntil ?? null,
    furnishingStatus: a.furnishingStatus ?? null,
    petsPolicy: a.petsPolicy ?? null,
    smokingPolicy: a.smokingPolicy ?? null,
    leaseType: a.leaseType ?? null,
    minimumLeaseMonths: a.minimumLeaseMonths ?? null,
    maximumOccupants: a.maximumOccupants ?? null,
    amenitiesAbsentJson: JSON.stringify(a.amenitiesAbsent || []),
    rentInclusionsJson: JSON.stringify(a.rentInclusions || []),
    requirementsJson: JSON.stringify(a.requirements || []),
    conflictsJson: JSON.stringify(a.conflicts || []),
    recurringCostsJson: JSON.stringify(a.recurringCosts || {}),
    oneTimeBuyoutEur: a.oneTimeBuyoutEur ?? null,
  };
}

function json(value) {
  return value == null ? null : JSON.stringify(value);
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
