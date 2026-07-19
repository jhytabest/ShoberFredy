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
import { scoreListingNow } from '../scoring/marketScore.js';
import { structuredFeatureFlags } from '../scoring/hedonicFeatures.js';
import { enqueueNotificationDeliveries } from './notificationOutbox.js';
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
 * extraction, geocode, score, decide visibility, dedupe, store, and enqueue
 * notifications.
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
    if (!stored.hidden_reason) enqueueNotificationDeliveries(stored.id, job, queue.provider);
    return { status: 'completed', listingId: stored.id };
  }

  const listing = buildCanonical(queue, llm);
  await attachCoordinates(listing, job, allowMissingCoordinates);
  listing.attributes.features = structuredFeatureFlags(listing.attributes);
  try {
    listing.marketScore = scoreListingNow(listing, listing.attributes);
  } catch {
    // Scoring is deliberately fail-open.
  }
  listing.hidden_reason = visibilityVerdict(listing, job);

  const identity = { title: listing.title, address: listing.address, price: listing.price };
  const deduped = dropDuplicates([listing], { similarityCache, providerId: queue.provider });
  if (deduped.length === 0) return { status: 'duplicate', listingId: null };

  const [listingId] = storeListings(job.id, queue.provider, [listing]);
  if (!listingId) throw new Error('Canonical listing could not be stored');
  similarityCache.addEntry(identity);
  attachDistance(listingId, listing, job);
  if (!listing.hidden_reason) enqueueNotificationDeliveries(listingId, job, queue.provider);
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
  try {
    const score = scoreListingNow({ ...existing, ...candidate }, candidate.attributes);
    storeScores(db, existing.id, score);
  } catch {
    // Scoring is deliberately fail-open.
  }
  return { status: 'completed', listingId: existing.id };
}

/**
 * Build the canonical listing from the capture and the validated LLM
 * extraction. The scraped discovery card supplies base facts (title, price,
 * size, address) as fallback when the extraction returned null; everything
 * structured comes exclusively from the LLM.
 *
 * @param {object} queue hydrated parsing_queue row
 * @param {object} llm validated LLM extraction (may be null in tests)
 * @returns {object} canonical listing with `attributes`
 */
export function buildCanonical(queue, llm) {
  const discovery = queue.capture.discoveryData || {};
  const structured = llm || {};
  const rent = structured.rent || {};
  const energy = structured.energy || {};
  const priceType = rent.price_type || 'unknown';
  const coldRent = rent.cold ?? null;
  const warmRent = rent.warm ?? null;
  const price =
    priceType === 'cold'
      ? first(coldRent, discovery.price)
      : priceType === 'warm'
        ? first(warmRent, discovery.price)
        : first(discovery.price, coldRent, warmRent);

  return {
    id: queue.source_hash,
    created_at: queue.discovered_at,
    provider: queue.provider,
    link: queue.capture.sourceUrl || discovery.link,
    title: first(structured.title, discovery.title, ''),
    address: first(structured.address, discovery.address),
    description: queue.capture.fullText || discovery.description || '',
    image: queue.capture.images?.[0]?.originalUrl || discovery.image || null,
    price,
    size: first(structured.size_sqm, discovery.size),
    rooms: first(structured.rooms, discovery.rooms),
    attributes: {
      coldRentEur: coldRent,
      warmRentEur: warmRent,
      serviceChargesEur: rent.service_charges ?? null,
      heatingCostsEur: rent.heating_costs ?? null,
      depositEur: rent.deposit ?? null,
      priceType,
      rooms: first(structured.rooms, discovery.rooms),
      floor: structured.floor ?? null,
      buildingYear: structured.building_year ?? null,
      propertyType: structured.property_type ?? null,
      energyClass: energy.class ?? null,
      petsAllowed: structured.pets_allowed ?? null,
      availability: structured.availability ?? 'unknown',
      availableFrom: structured.available_from ?? null,
      swap: structured.listing_type === 'swap',
      listingType: structured.listing_type || 'unknown',
      bedrooms: structured.bedrooms ?? null,
      bathrooms: structured.bathrooms ?? null,
      totalFloors: structured.total_floors ?? null,
      condition: structured.condition ?? null,
      furnished: structured.furnished ?? null,
      heatingType: energy.heating_type ?? null,
      energyValueKwh: energy.value_kwh ?? null,
      amenities: Array.isArray(structured.amenities) ? structured.amenities : [],
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
       energy_value_kwh, amenities_json, availability, comments, schema_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       schema_version=excluded.schema_version`,
  ).run(
    listingId,
    a.coldRentEur ?? null,
    a.warmRentEur ?? null,
    a.serviceChargesEur ?? null,
    a.heatingCostsEur ?? null,
    a.depositEur ?? null,
    a.priceType ?? null,
    a.rooms ?? null,
    a.floor ?? null,
    a.buildingYear ?? null,
    a.propertyType ?? null,
    a.energyClass ?? null,
    a.petsAllowed == null ? null : a.petsAllowed ? 1 : 0,
    a.availableFrom ?? null,
    a.swap ? 1 : 0,
    JSON.stringify(a.features || {}),
    Date.now(),
    a.listingType ?? null,
    a.bedrooms ?? null,
    a.bathrooms ?? null,
    a.totalFloors ?? null,
    a.condition ?? null,
    a.furnished == null ? null : a.furnished ? 1 : 0,
    a.heatingType ?? null,
    a.energyValueKwh ?? null,
    JSON.stringify(a.amenities || []),
    a.availability ?? null,
    a.comments ?? null,
    PIPELINE_SCHEMA_VERSION,
  );
}

function storeScores(db, listingId, score) {
  if (!score?.models) return;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO homeserver_listing_model_scores (
       listing_id, model_family, model_version, scored_at, model_created_at,
       actual_price_per_sqm, fair_price_per_sqm, fair_lo_price_per_sqm, fair_hi_price_per_sqm,
       coverage_level, delta_percent, comps_500m, coord_quality, price_type, swap
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const model of Object.values(score.models)) {
    if (!model) continue;
    stmt.run(
      listingId,
      model.family,
      model.version ?? 'unknown',
      Date.now(),
      model.modelCreatedAt ?? null,
      score.actualPricePerSqm,
      model.fairPricePerSqm,
      model.fairLoPricePerSqm ?? null,
      model.fairHiPricePerSqm ?? null,
      model.coverageLevel ?? null,
      model.deltaPercent,
      model.comps500m ?? null,
      score.coordQuality ?? null,
      score.priceType ?? null,
      score.swap ? 1 : 0,
    );
  }
}

function first(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? null;
}
