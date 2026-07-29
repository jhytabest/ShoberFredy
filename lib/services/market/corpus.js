/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Training corpus shared by BOTH market models (ridge and GBM).
 *
 * One extraction path, one target definition, one deduplication pass — the
 * models must disagree because of their estimators, never because they saw
 * different data.
 *
 * Target policy (cold-equivalent rent):
 * - parsed Kaltmiete → cold;
 * - provider-declared cold price → cold;
 * - warm rent with parsed service charges → imputed cold ('cold_est');
 * - anything else (warm without breakdown, unknown) is NOT trainable: mixing
 *   warm and unknown prices into a cold €/m² target biases every neighborhood
 *   where they concentrate. Those rows are still scored and notified — the
 *   score line labels the rent kind — they just never teach the model.
 *
 * Coordinates: rows without usable coordinates are KEPT (tier 'missing',
 * x/y NaN). The GBM consumes NaN coordinates natively; the ridge uses such
 * rows for its hedonic fit and skips them in the spatial residual field.
 * The projection reference latitude is derived from the data (median
 * listing latitude), not hardcoded to a city.
 *
 * Outliers: instead of a fixed €/m² band, training rows outside
 * median ± 5 scaled-MADs of log €/m² are trimmed — the band adapts to
 * whatever market the corpus actually covers.
 *
 * Duplicate clusters: every row carries a clusterId (same trusted geocode
 * point + same size → same physical flat, across portals and price edits).
 * The evaluation folds and the ridge residual field exclude same-cluster
 * rows, so a flat can never be predicted from copies of itself.
 */

import { normalizeAddress } from '../geocoding/address.js';
import { structuredFeatureFlags, MAX_MONTH_OFFSETS } from '../scoring/hedonicFeatures.js';
import { coordQualityTier } from './conformal.js';
import { buildProjection, gridKey, hasUsableCoordinates } from './geo.js';
import { median, medianAbsoluteDeviation } from './stats.js';

const FALLBACK_REFERENCE_LATITUDE = 52.52;
const DAYS_PER_MONTH = 30;
const DUPLICATE_PRICE_TOLERANCE = 0.02;
const CLUSTER_COORD_DECIMALS = 4; // ~11 m: same building entrance
const DUPLICATE_COORD_DECIMALS = 5; // ~1.1 m: same geocode point
const OUTLIER_MAD_MULTIPLIER = 5;
const MAD_SCALE = 1.4826;
const TRUSTED_ACCURACIES = new Set(['house', 'street']);
/** Surface cell edge (meters) shared with the ridge artifact and scorer. */
export const SURFACE_CELL_M = 125;

/**
 * Cold-equivalent rent for a listing. Shared verbatim between corpus
 * construction (training) and the notification-time scorer, so training
 * target and scored quantity can never diverge.
 *
 * @param {object} attrs structured listing attributes
 * @param {number} price the stored price column
 * @returns {{rent: number|null, type: 'cold'|'cold_est'|'warm'|'unknown'}}
 *   rent is null when no cold-equivalent can be established.
 */
export function coldEquivalentRent(attrs, price) {
  if (attrs?.coldRentEur > 0) return { rent: attrs.coldRentEur, type: 'cold' };
  if (attrs?.priceType === 'cold' && price > 0) return { rent: price, type: 'cold' };
  const warm = attrs?.warmRentEur > 0 ? attrs.warmRentEur : attrs?.priceType === 'warm' && price > 0 ? price : null;
  if (warm != null && attrs?.serviceChargesEur > 0) {
    const estimate = warm - attrs.serviceChargesEur - (attrs.heatingCostsEur > 0 ? attrs.heatingCostsEur : 0);
    // Sanity guard, not a market assumption: a "cold" rent below 40% of warm
    // means the parsed charges are wrong (e.g. yearly instead of monthly).
    if (estimate > 0 && estimate >= 0.4 * warm) return { rent: estimate, type: 'cold_est' };
  }
  return { rent: null, type: attrs?.priceType === 'warm' ? 'warm' : 'unknown' };
}

/**
 * Exponential recency weight.
 * @param {number} ageDays
 * @param {number} halfLifeDays
 * @param {number} [minWeight]
 * @returns {number}
 */
export function weightFor(ageDays, halfLifeDays, minWeight = 0.05) {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;
  return Math.max(minWeight, Math.exp(-Math.LN2 * (ageDays / halfLifeDays)));
}

/**
 * Load, deduplicate and enrich the corpus.
 *
 * @param {import('better-sqlite3').Database} db handle with the
 *   homeserver_address_key UDF registered (see marketDb.openToolDb)
 * @param {number} now epoch ms
 * @returns {{
 *   rows: object[],          // every unique scorable flat (incl. warm/unknown)
 *   trainingRows: object[],  // cold-equivalent target, outliers trimmed
 *   projection: object,      // buildProjection output derived from the data
 *   stats: object,
 * }}
 */
export function loadCorpus(db, now) {
  const raw = queryRows(db);
  const { unique, swapExcluded } = collapseDuplicates(raw);

  const referenceLatitude =
    median(
      unique.filter((row) => hasUsableCoordinates(row.latitude, row.longitude)).map((row) => Number(row.latitude)),
    ) ?? FALLBACK_REFERENCE_LATITUDE;
  const projection = buildProjection(referenceLatitude);

  const rows = unique.map((row) => enrichRow(row, now, projection));

  const candidates = rows.filter((row) => row.targetRent != null && row.logPricePerSqm != null);
  const logValues = candidates.map((row) => row.logPricePerSqm);
  const center = median(logValues);
  const spread = (medianAbsoluteDeviation(logValues) ?? 0) * MAD_SCALE;
  const trainingRows =
    center == null || spread === 0
      ? candidates
      : candidates.filter((row) => Math.abs(row.logPricePerSqm - center) <= OUTLIER_MAD_MULTIPLIER * spread);

  return {
    rows,
    trainingRows,
    projection,
    stats: {
      rawRows: raw.length,
      uniqueFlats: rows.length,
      swapExcluded,
      trainableRows: trainingRows.length,
      unknownPriceType: rows.length - candidates.length,
      outlierExcluded: candidates.length - trainingRows.length,
      referenceLatitude,
    },
  };
}

function queryRows(db) {
  // Spec/area-filtered listings ARE kept: they are valid Berlin market
  // observations (out-of-budget / out-of-polygon is a user preference, not bad
  // data) and give the spatial model its geographic spread. 'no_detail' legacy
  // rows have no verified evidence and stay out.
  // WG rooms, sublets, swaps and furnished flats are priced on a different
  // market and have to stay out of the corpus. Testing `hidden_reason` for that
  // does not work: it only says why the user's filters rejected a listing, so a
  // furnished flat that was hidden for being out of budget — or not hidden at
  // all — still counted as an ordinary rental. Sixty-three of roughly eight
  // hundred training rows were of that kind. Ask the extraction instead; it
  // states the property type directly.
  return db
    .prepare(
      `
      SELECT
        l.id, l.created_at, l.price, l.size, l.rooms, l.title,
        l.address, l.link, l.provider, l.job_id, l.latitude, l.longitude,
        l.manually_deleted,
        COALESCE(c.accuracy, c.status, '') AS geocode_quality,
        a.parsed_at AS attrs_parsed_at, a.cold_rent_eur AS attr_cold_rent_eur,
        a.warm_rent_eur AS attr_warm_rent_eur, a.service_charges_eur AS attr_service_charges_eur,
        a.heating_costs_eur AS attr_heating_costs_eur, a.deposit_eur AS attr_deposit_eur,
        a.price_type AS attr_price_type, a.rooms AS attr_rooms, a.floor AS attr_floor,
        a.building_year AS attr_building_year, a.property_type AS attr_property_type,
        a.energy_class AS attr_energy_class, a.pets_allowed AS attr_pets_allowed,
        a.available_from AS attr_available_from, a.swap AS attr_swap, a.features_json AS attr_features_json,
        a.bedrooms AS attr_bedrooms, a.bathrooms AS attr_bathrooms,
        a.total_floors AS attr_total_floors, a.furnishing_status AS attr_furnishing_status,
        a.lease_type AS attr_lease_type, a.amenities_json AS attr_amenities_json,
        a.amenities_absent_json AS attr_amenities_absent_json
      FROM listings l
      JOIN jobs j ON j.id = l.job_id
      LEFT JOIN homeserver_geocode_cache c
        ON c.address_key = homeserver_address_key(l.address)
      JOIN listing_attributes a ON a.listing_id = l.id
      WHERE json_array_length(j.notification_adapter) > 0
        AND (l.hidden_reason IS NULL OR l.hidden_reason NOT IN ('blacklist', 'no_detail'))
        AND COALESCE(a.furnished, 0) != 1
        AND COALESCE(a.swap, 0) != 1
        AND COALESCE(a.listing_type, 'rental') NOT IN ('sublet', 'wg_room', 'swap')
        AND l.price IS NOT NULL AND l.price > 0
        AND l.size IS NOT NULL AND l.size BETWEEN 10 AND 400
      `,
    )
    .all();
}

/**
 * Reconstruct the structured-attributes shape from a joined listing_attributes
 * row (columns prefixed by the SELECT above).
 */
function storedAttrs(row) {
  let features;
  try {
    features = row.attr_features_json ? JSON.parse(row.attr_features_json) : null;
  } catch {
    features = null;
  }
  return {
    coldRentEur: row.attr_cold_rent_eur,
    warmRentEur: row.attr_warm_rent_eur,
    serviceChargesEur: row.attr_service_charges_eur,
    heatingCostsEur: row.attr_heating_costs_eur,
    depositEur: row.attr_deposit_eur,
    priceType: row.attr_price_type ?? 'unknown',
    rooms: row.attr_rooms,
    bedrooms: row.attr_bedrooms,
    bathrooms: row.attr_bathrooms,
    floor: row.attr_floor,
    totalFloors: row.attr_total_floors,
    buildingYear: row.attr_building_year,
    propertyType: row.attr_property_type,
    energyClass: row.attr_energy_class,
    petsAllowed: row.attr_pets_allowed == null ? null : Boolean(row.attr_pets_allowed),
    availableFrom: row.attr_available_from,
    swap: Boolean(row.attr_swap),
    furnishingStatus: row.attr_furnishing_status ?? 'unknown',
    leaseType: row.attr_lease_type ?? 'unknown',
    amenities: parseJsonArray(row.attr_amenities_json),
    amenitiesAbsent: parseJsonArray(row.attr_amenities_absent_json),
    features,
  };
}

/*
 * Collapse to one row per flat, regardless of job or portal:
 * 1. same link → newest version wins (a portal edit re-inserts the ad);
 * 2. same trusted geocode point + same size + price within ±2% → the row
 *    with the richest data wins (known cold rent beats unknown, then newer).
 * Rows surviving step 2 at the same point+size but a DIFFERENT price are
 * kept (price edit / relisting) but share a clusterId.
 */
function collapseDuplicates(rawRows) {
  const withAttrs = [];
  let swapExcluded = 0;
  for (const row of rawRows) {
    const attrs = storedAttrs(row);
    if (attrs.swap) {
      swapExcluded += 1;
      continue;
    }
    withAttrs.push({ ...row, attrs });
  }

  const byLink = new Map();
  for (const row of withAttrs) {
    const key = row.link || `no-link:${row.id}`;
    const existing = byLink.get(key);
    if (!existing || row.created_at > existing.created_at) byLink.set(key, row);
  }

  const clusters = new Map();
  const unique = [];
  for (const row of byLink.values()) {
    if (!TRUSTED_ACCURACIES.has(row.geocode_quality) || !hasUsableCoordinates(row.latitude, row.longitude)) {
      unique.push(row);
      continue;
    }
    const pointKey = `${Number(row.latitude).toFixed(DUPLICATE_COORD_DECIMALS)}:${Number(row.longitude).toFixed(
      DUPLICATE_COORD_DECIMALS,
    )}:${row.size}`;
    const bucket = clusters.get(pointKey);
    if (!bucket) {
      clusters.set(pointKey, [row]);
      continue;
    }
    const match = bucket.find(
      (candidate) =>
        Math.abs(Number(candidate.price) - Number(row.price)) <=
        DUPLICATE_PRICE_TOLERANCE * Math.max(Number(candidate.price), Number(row.price)),
    );
    if (!match) {
      bucket.push(row);
      continue;
    }
    if (richness(row) > richness(match)) bucket[bucket.indexOf(match)] = row;
  }
  for (const bucket of clusters.values()) unique.push(...bucket);

  return { unique, swapExcluded };
}

function richness(row) {
  return (row.attrs.coldRentEur != null ? 10 : 0) + (row.attrs.rooms != null ? 1 : 0) + row.created_at / 1e15;
}

function enrichRow(row, now, projection) {
  const attrs = row.attrs;
  const size = Number(row.size);
  const price = Number(row.price);
  const target = coldEquivalentRent(attrs, price);
  const usableCoords = hasUsableCoordinates(row.latitude, row.longitude);
  const latitude = usableCoords ? Number(row.latitude) : null;
  const longitude = usableCoords ? Number(row.longitude) : null;
  const projected = usableCoords ? projection.project(latitude, longitude) : { x: NaN, y: NaN };
  const createdAt = Number.isFinite(Number(row.created_at)) ? Number(row.created_at) : now;
  const ageDays = Math.max(0, (now - createdAt) / (24 * 60 * 60 * 1000));
  const address = normalizeAddress(row.address);
  const features = attrs.features ?? structuredFeatureFlags(attrs);
  const tier = coordQualityTier(row.geocode_quality, usableCoords);
  const clusterId =
    usableCoords && TRUSTED_ACCURACIES.has(row.geocode_quality)
      ? `${latitude.toFixed(CLUSTER_COORD_DECIMALS)}:${longitude.toFixed(CLUSTER_COORD_DECIMALS)}:${size}`
      : `solo:${row.id}`;

  return {
    id: row.id,
    link: row.link,
    provider: row.provider,
    title: row.title,
    createdAt,
    ageDays,
    monthOffset: Math.min(Math.floor(ageDays / DAYS_PER_MONTH), MAX_MONTH_OFFSETS),
    price,
    targetRent: target.rent,
    priceType: target.type,
    size,
    rooms: attrs.rooms,
    bedrooms: attrs.bedrooms,
    bathrooms: attrs.bathrooms,
    floor: attrs.floor,
    totalFloors: attrs.totalFloors,
    buildingYear: attrs.buildingYear,
    propertyType: attrs.propertyType,
    latitude,
    longitude,
    x: projected.x,
    y: projected.y,
    hasCoords: usableCoords,
    tier,
    clusterId,
    rawPricePerSqm: price / size,
    pricePerSqm: target.rent != null ? target.rent / size : price / size,
    logPricePerSqm: target.rent != null ? Math.log(target.rent / size) : null,
    area: inferArea(address),
    geoCell: usableCoords ? gridKey(projected.x, projected.y, SURFACE_CELL_M) : null,
    geocodeQuality: row.geocode_quality || 'unknown',
    isHidden: Number(row.manually_deleted) === 1,
    features,
    attrs,
  };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Reporting-only district label from the address text (feeds the Grafana
 * group-by; never a model input). Exported because the metrics exporter
 * re-derives it from the address at scrape time rather than reading a stored
 * copy that could describe an older classifier.
 *
 * @param {string} address normalizeAddress output
 * @returns {string}
 */
export function inferArea(address) {
  const normalized = String(address || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
  for (const area of AREAS) {
    if (area.patterns.some((pattern) => pattern.test(normalized))) {
      return area.name;
    }
  }
  return 'unknown';
}

const AREAS = [
  { name: 'alt_treptow', patterns: [/\balt[- ]treptow\b/] },
  { name: 'charlottenburg_wilmersdorf', patterns: [/\bcharlottenburg\b/, /\bwilmersdorf\b/] },
  { name: 'friedrichshain_kreuzberg', patterns: [/\bfriedrichshain\b/, /\bkreuzberg\b/] },
  { name: 'lichtenberg', patterns: [/\blichtenberg\b/] },
  { name: 'mitte', patterns: [/\bmitte\b/, /\bwedding\b/, /\bmoabit\b/, /\bgesundbrunnen\b/] },
  { name: 'neukoelln', patterns: [/\bneukolln\b/, /\bneukoelln\b/] },
  { name: 'pankow_prenzlauer_berg', patterns: [/\bprenzlauer berg\b/, /\bpankow\b/, /\bweissensee\b/] },
  { name: 'schoeneberg_tempelhof', patterns: [/\bschoneberg\b/, /\bschoeneberg\b/, /\btempelhof\b/] },
  { name: 'steglitz_zehlendorf', patterns: [/\bsteglitz\b/, /\bzehlendorf\b/, /\bdahlem\b/] },
  { name: 'treptow_koepenick', patterns: [/\btreptow\b/, /\bkopenick\b/, /\bkoepenick\b/] },
];
