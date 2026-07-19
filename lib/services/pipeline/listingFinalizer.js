/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { isOneOf } from '../../utils.js';
import { getJob } from '../storage/jobStorage.js';
import { getUserSettings } from '../storage/settingsStorage.js';
import { storeListings, updateListingDistance } from '../storage/listingsStorage.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { geocodeAddress } from '../geocoding/geoCodingService.js';
import { distanceMeters } from '../listings/distanceCalculator.js';
import { dropDuplicates } from '../listings/dedupe.js';
import * as similarityCache from '../similarity-check/similarityCache.js';
import { structuredFeatureFlags } from '../scoring/hedonicFeatures.js';
import { enqueueRating } from './ratingQueue.js';
import { PIPELINE_SCHEMA_VERSION } from './pipelineVersion.js';
import { sendToUser } from '../sse/sse-broker.js';

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
 * only the outbox enqueue (INSERT OR IGNORE) is repeated. The similarity
 * cache is consulted read-only and committed only after a successful store,
 * so a retry can never misclassify its own listing as a duplicate.
 *
 * @param {object} queue hydrated parsing_queue row
 * @param {object} llm validated LLM extraction
 * @param {{allowMissingCoordinates?: boolean}} [options]
 * @returns {Promise<{status: string, listingId: string|null}>}
 */
export async function finalizeLive(queue, llm, { allowMissingCoordinates = false } = {}) {
  const job = getJob(queue.job_id);
  if (!job) throw new Error(`Job '${queue.job_id}' no longer exists`);

  const db = SqliteConnection.getConnection();
  const stored = db
    .prepare('SELECT id, hidden_reason, latitude, longitude FROM listings WHERE job_id = ? AND hash = ?')
    .get(queue.job_id, queue.source_hash);
  if (stored) {
    // Replay everything after the store that a crashed attempt may have
    // skipped; both operations are idempotent.
    attachDistance(stored.id, stored, job);
    enqueueRating(stored.id, job.id, queue.provider, { notify: !stored.hidden_reason });
    return { status: 'completed', listingId: stored.id };
  }

  const listing = buildCanonical(queue, llm);
  await attachCoordinates(listing, job, allowMissingCoordinates);
  listing.attributes.features = structuredFeatureFlags(listing.attributes);
  listing.hidden_reason = visibilityVerdict(listing, job);

  const identity = { title: listing.title, address: listing.address, price: listing.price };
  const deduped = dropDuplicates([listing], { similarityCache, providerId: queue.provider });
  if (deduped.length === 0) return { status: 'duplicate', listingId: null };

  const [listingId] = storeListings(job.id, queue.provider, [listing]);
  if (!listingId) throw new Error('Canonical listing could not be stored');
  similarityCache.addEntry(identity);
  attachDistance(listingId, listing, job);
  enqueueRating(listingId, job.id, queue.provider, { notify: !listing.hidden_reason });
  if (job.userId) sendToUser(job.userId, 'listings:new', { jobId: job.id, count: 1 });
  return { status: 'completed', listingId };
}

/**
 * Finalize a backfill queue item: refresh the stored listing's structured
 * attributes (and coordinates/scores where possible) from the text-only LLM
 * extraction. Never stores new listings and never notifies.
 *
 * @param {object} queue hydrated parsing_queue row
 * @param {object} llm validated LLM extraction
 * @param {{allowMissingCoordinates?: boolean}} [options]
 * @returns {Promise<{status: string, listingId: string}>}
 */
export async function finalizeBackfill(queue, llm, { allowMissingCoordinates = false } = {}) {
  const db = SqliteConnection.getConnection();
  const existing = db.prepare('SELECT * FROM listings WHERE id = ?').get(queue.listing_id);
  if (!existing) throw new Error(`Backfill listing '${queue.listing_id}' no longer exists`);
  const job = getJob(existing.job_id);
  const candidate = buildCanonical(queue, llm);
  candidate.id = existing.id;
  candidate.latitude = existing.latitude;
  candidate.longitude = existing.longitude;
  if ((candidate.latitude == null || candidate.longitude == null) && job) {
    await attachCoordinates(candidate, job, allowMissingCoordinates);
    if (candidate.latitude != null && candidate.longitude != null) {
      db.prepare('UPDATE listings SET latitude = ?, longitude = ? WHERE id = ?').run(
        candidate.latitude,
        candidate.longitude,
        existing.id,
      );
    }
  }
  candidate.attributes.features = structuredFeatureFlags(candidate.attributes);
  upsertAttributes(db, existing.id, candidate.attributes);
  enqueueRating(existing.id, existing.job_id, existing.provider, { notify: false });
  return { status: 'completed', listingId: existing.id };
}

/**
 * Build the canonical listing from the capture and the validated LLM
 * extraction. Discovery-card facts are deliberately excluded: every semantic
 * field remains the validated LLM value, including null when evidence is
 * missing.
 *
 * @param {object} queue hydrated parsing_queue row
 * @param {object} llm validated LLM extraction (may be null in tests)
 * @returns {object} canonical listing with `attributes`
 */
export function buildCanonical(queue, llm) {
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
    created_at: queue.discovered_at,
    provider: queue.provider,
    link: queue.capture.sourceUrl || queue.source_url,
    title: structured.title ?? '',
    address: structured.address ?? null,
    description: queue.capture.fullText || '',
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
    },
  };
}

async function attachCoordinates(listing, job, allowMissingCoordinates) {
  if (!listing.address) return;
  const coords = await geocodeAddress(listing.address);
  if (coords == null) {
    if (!allowMissingCoordinates) throw new GeocodeDeferredError('Google geocoding is unavailable');
    return;
  }
  if (coords.lat !== -1 && coords.lng !== -1) {
    listing.latitude = coords.lat;
    listing.longitude = coords.lng;
  }
}

function visibilityVerdict(listing, job) {
  if (isOneOf(listing.title, job.blacklist || []) || isOneOf(listing.description, job.blacklist || []))
    return 'blacklist';
  const { minRooms, minSize, maxPrice } = job.specFilter || {};
  if (
    (minRooms && listing.rooms != null && listing.rooms < minRooms) ||
    (minSize && listing.size != null && listing.size < minSize) ||
    (maxPrice && listing.price != null && listing.price > maxPrice)
  ) {
    return 'spec_filter';
  }
  const polygons = job.spatialFilter?.features?.filter((feature) => feature.geometry?.type === 'Polygon');
  if (polygons?.length) {
    const lat = Number(listing.latitude);
    const lng = Number(listing.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'no_coordinates';
    if (!polygons.some((polygon) => booleanPointInPolygon([lng, lat], polygon))) return 'area_filter';
  }
  return null;
}

function attachDistance(listingId, listing, job) {
  const home = getUserSettings(job.userId)?.home_address?.coords;
  if (!home || listing.latitude == null || listing.longitude == null) return;
  updateListingDistance(listingId, distanceMeters(home.lat, home.lng, listing.latitude, listing.longitude));
}

function upsertAttributes(db, listingId, a) {
  db.prepare(
    `INSERT INTO listing_attributes (
       listing_id, cold_rent_eur, warm_rent_eur, service_charges_eur, heating_costs_eur,
       deposit_eur, price_type, rooms, floor, building_year, property_type, energy_class,
       pets_allowed, available_from, swap, features_json, parsed_at, listing_type,
       bedrooms, bathrooms, total_floors, condition, furnished, heating_type,
       energy_value_kwh, amenities_json, availability, comments, schema_version,
       address_json, availability_precision, available_until, furnishing_status,
       pets_policy, smoking_policy, lease_type, minimum_lease_months, maximum_occupants,
       amenities_absent_json, rent_inclusions_json, requirements_json, conflicts_json,
       recurring_costs_json, one_time_buyout_eur
     ) VALUES (
       @listingId, @coldRentEur, @warmRentEur, @serviceChargesEur, @heatingCostsEur,
       @depositEur, @priceType, @rooms, @floor, @buildingYear, @propertyType, @energyClass,
       @petsAllowed, @availableFrom, @swap, @featuresJson, @parsedAt, @listingType,
       @bedrooms, @bathrooms, @totalFloors, @condition, @furnished, @heatingType,
       @energyValueKwh, @amenitiesJson, @availability, @comments, @schemaVersion,
       @addressJson, @availabilityPrecision, @availableUntil, @furnishingStatus,
       @petsPolicy, @smokingPolicy, @leaseType, @minimumLeaseMonths, @maximumOccupants,
       @amenitiesAbsentJson, @rentInclusionsJson, @requirementsJson, @conflictsJson,
       @recurringCostsJson, @oneTimeBuyoutEur
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
       schema_version=excluded.schema_version`,
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
    schemaVersion: PIPELINE_SCHEMA_VERSION,
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
