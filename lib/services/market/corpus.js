/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { normalizeAddress } from '../geocoding/address.js';
import { listingAttributes } from '../listings/attributes.js';
import { structuredFeatureFlags } from '../scoring/hedonicFeatures.js';
import { coordQualityTier } from './conformal.js';
import { buildProjection, hasUsableCoordinates } from './geo.js';
import { median, medianAbsoluteDeviation } from './stats.js';
import { IN_MARKET_CORPUS_SQL } from '../pipeline/terminalVerdict.js';

const FALLBACK_REFERENCE_LATITUDE = 52.52;
const DUPLICATE_PRICE_TOLERANCE = 0.02;
const CLUSTER_COORD_DECIMALS = 4;
const DUPLICATE_COORD_DECIMALS = 5;
const OUTLIER_MAD_MULTIPLIER = 5;
const MAD_SCALE = 1.4826;
const TRUSTED_ACCURACIES = new Set(['house', 'street']);
// Matches MIN_TRAINING_ROWS in ridgeModel.js / gbmModel.js: a market this thin
// never trains, so listing it here just repeats a training failure — and its
// warning — on every run.
const MIN_MARKET_ROWS = 40;

export function coldRent(attrs, price) {
  if (attrs?.coldRentEur > 0) return attrs.coldRentEur;
  if (attrs?.priceType === 'cold' && price > 0) return price;
  return null;
}

// The markets worth training: every city with adverts in the corpus. A market
// with too few of them simply fails to train and keeps whatever model it had,
// which is the same answer the single corpus used to give when it was small.
export function corpusMarkets(db) {
  return db
    .prepare(
      `SELECT l.market AS market, COUNT(1) AS rows
       FROM listings l
       JOIN listing_attributes a ON a.listing_id = l.id
       WHERE l.market IS NOT NULL AND ${IN_MARKET_CORPUS_SQL('l')}
       GROUP BY l.market
       ORDER BY rows DESC`,
    )
    .all()
    .filter((row) => row.rows >= MIN_MARKET_ROWS);
}

export function loadCorpus(db, now, market) {
  const raw = queryRows(db, market);
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
    market,
    stats: {
      market,
      rawRows: raw.length,
      uniqueFlats: rows.length,
      swapExcluded,
      trainableRows: trainingRows.length,
      noColdRent: rows.length - candidates.length,
      outlierExcluded: candidates.length - trainingRows.length,
      referenceLatitude,
    },
  };
}

function queryRows(db, market) {
  return db
    .prepare(
      `
      SELECT
        l.id, l.created_at, l.price, l.size, l.rooms, l.title,
        l.address, l.link, l.provider, l.latitude, l.longitude, l.state, l.market,
        COALESCE(c.accuracy, c.status, '') AS geocode_quality,
        a.parsed_at AS attrs_parsed_at, a.data AS attr_data,
        t.full_text AS full_text
      FROM listings l
      LEFT JOIN homeserver_geocode_cache c
        ON c.address_key = homeserver_address_key(l.address, l.market)
      JOIN listing_attributes a ON a.listing_id = l.id
      LEFT JOIN listing_texts t ON t.listing_id = l.id
      WHERE l.market = @market
        AND ${IN_MARKET_CORPUS_SQL('l')}
        AND COALESCE(json_extract(a.data, '$.furnished'), 0) != 1
        AND COALESCE(json_extract(a.data, '$.swap'), 0) != 1
        AND COALESCE(json_extract(a.data, '$.listingType'), 'rental') NOT IN ('sublet', 'wg_room', 'swap')
        AND l.price IS NOT NULL AND l.price > 0
        AND l.size IS NOT NULL AND l.size BETWEEN 10 AND 400
      `,
    )
    .all({ market });
}

function storedAttrs(row) {
  return listingAttributes(row.attr_data);
}

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
  return (row.attrs.coldRentEur != null ? 10 : 0) + (row.rooms != null ? 1 : 0) + row.created_at / 1e15;
}

function enrichRow(row, now, projection) {
  const attrs = row.attrs;
  const size = Number(row.size);
  const price = Number(row.price);
  const targetRent = coldRent(attrs, price);
  const usableCoords = hasUsableCoordinates(row.latitude, row.longitude);
  const latitude = usableCoords ? Number(row.latitude) : null;
  const longitude = usableCoords ? Number(row.longitude) : null;
  const projected = usableCoords ? projection.project(latitude, longitude) : { x: NaN, y: NaN };
  const createdAt = Number.isFinite(Number(row.created_at)) ? Number(row.created_at) : now;
  const address = normalizeAddress(row.address);
  const features = structuredFeatureFlags(attrs, row.full_text);
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
    price,
    targetRent,
    size,
    rooms: Number.isFinite(Number(row.rooms)) ? Number(row.rooms) : null,
    bedrooms: attrs.bedrooms,
    bathrooms: attrs.bathrooms,
    floor: attrs.floor,
    totalFloors: attrs.totalFloors,
    buildingYear: attrs.buildingYear,
    propertyType: attrs.propertyType,
    condition: attrs.condition,
    energyClass: attrs.energyClass,
    latitude,
    longitude,
    x: projected.x,
    y: projected.y,
    hasCoords: usableCoords,
    tier,
    clusterId,
    rawPricePerSqm: price / size,
    pricePerSqm: targetRent != null ? targetRent / size : price / size,
    logPricePerSqm: targetRent != null ? Math.log(targetRent / size) : null,
    area: inferArea(address),
    geocodeQuality: row.geocode_quality || 'unknown',
    isHidden: row.state !== 'active',
    features,
    attrs,
  };
}

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
