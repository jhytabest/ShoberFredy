/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Shoberfredy market model: geo-surface-v3.
 *
 * Trains on UNIQUE FLATS from the notifying ("main") jobs only — shadow rows
 * are excluded, cross-job/cross-portal duplicates are collapsed first (same
 * link keeps the newest version; same trusted geocode + size + price ±2%
 * keeps the richest row). Swap listings (Tauschwohnung) are excluded: their
 * rents are old-contract prices, not market offers.
 *
 * Two jointly used parts, retrained from scratch every run:
 *
 * 1. A robust weighted ridge regression on log EUR/m2 (cold rent where the
 *    portal states it, with price-type dummies absorbing warm/unknown rents)
 *    over listing composition: size, rooms, floor, building year, property
 *    type, and text/structured feature flags. Time drift is captured by
 *    PENALIZED month-offset dummies — bounded by construction, unlike the
 *    v2 linear trend which extrapolated to -99%/yr from six weeks of data.
 * 2. A spatial residual field over the hedonic residuals: adaptive-bandwidth
 *    Gaussian kernel (bandwidth = distance to the k-th neighbour) with
 *    weighted medians, evaluated leave-one-out when scoring listings.
 *
 * Per-listing outputs are precise metrics, no verdict tags: fair EUR/m2,
 * delta %, residual z-score against local dispersion, weighted price
 * percentile among the local comps, confidence, and comps counts.
 *
 * Every run also evaluates itself before fitting the final model: a
 * time-ordered holdout (newest 20%) and a 5-fold spatially blocked CV,
 * reporting median absolute percentage error (MdAPE) and the share of
 * predictions within ±10% (PPE10), next to a predict-the-median baseline.
 * Metrics land in homeserver_model_runs.metrics_json for Grafana.
 *
 * The fitted hedonic state is persisted to homeserver_model_state so the
 * notification-time scorer (lib/services/scoring/marketScore.js) can price a
 * brand-new listing without retraining.
 *
 * Usage: node tools/market/marketModel.js [run|daemon|status]
 */

import fs from 'node:fs';
import path from 'node:path';

import { normalizeAddress } from '../geocoding/address.js';
import { parseListingAttrs } from '../scoring/listingAttrs.js';
import {
  MAX_MONTH_OFFSETS,
  hedonicDesignVector,
  hedonicDimensions,
  hedonicTermNames,
  textFeatureFlags,
  dot,
  clamp,
} from '../scoring/hedonicFeatures.js';
import { resolveDbPath, openToolDb } from './marketDb.js';
import logger from '../logger.js';

const MODEL_VERSION = 'geo-surface-v3';
const RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const BERLIN_LATITUDE = 52.52;
const METERS_PER_LATITUDE_DEGREE = 111320;
const METERS_PER_LONGITUDE_DEGREE = METERS_PER_LATITUDE_DEGREE * Math.cos((BERLIN_LATITUDE * Math.PI) / 180);
const INDEX_CELL_M = 250;
const SURFACE_CELL_M = 125;
const SURFACE_CELL_MARGIN = 2;

const RECENCY_HALF_LIFE_DAYS = 90;
const MIN_RECENCY_WEIGHT = 0.05;
const KERNEL_NEIGHBORS = 8;
const MIN_BANDWIDTH_M = 150;
const MAX_BANDWIDTH_M = 1200;
const SEARCH_RADIUS_M = 3 * MAX_BANDWIDTH_M;
const RIDGE_LAMBDA = 1;
const MIN_LOG_SPREAD = 0.05;
const DAYS_PER_MONTH = 30;
const DUPLICATE_PRICE_TOLERANCE = 0.02;
const DUPLICATE_COORD_DECIMALS = 5; // ~1.1 m
const TRUSTED_ACCURACIES = new Set(['house', 'street']);

const HOLDOUT_FRACTION = 0.2;
const MIN_HOLDOUT_ROWS = 40;
const SPATIAL_CV_FOLDS = 5;
const SPATIAL_CV_CELL_M = 500;

let config = null;
let db = null;

/**
 * Initialize the market model against the listings database. Idempotent;
 * must be called before any run/status function. Called by index.js for the
 * in-process retrain cron and by the tools/market/marketModel.js CLI.
 *
 * @param {{dbPath?: string}} [options]
 */
export async function initMarketModel(options = {}) {
  if (db) return;
  config = {
    dbPath: options.dbPath || (await resolveDbPath()),
    intervalSeconds: intEnv('FREDY_MARKET_MODEL_INTERVAL_SECONDS', 24 * 60 * 60),
    surfaceMinConfidence: numberEnv('FREDY_MARKET_SURFACE_MIN_CONFIDENCE', 0.25),
  };
  db = openToolDb(config.dbPath);
}

/**
 * Retrain loop for the standalone CLI daemon mode.
 */
export async function runMarketModelDaemon() {
  while (true) {
    try {
      runMarketModelOnce();
    } catch (error) {
      logger.error('market model run failed', error);
    }
    await sleep(config.intervalSeconds * 1000);
  }
}

/**
 * Interval (seconds) between retrains, from FREDY_MARKET_MODEL_INTERVAL_SECONDS.
 * @returns {number}
 */
export function marketModelIntervalSeconds() {
  return config.intervalSeconds;
}

/**
 * Retrain the market model once: fit hedonic + residual field on the current
 * corpus, persist run/scores/surface cells/state, write the surface GeoJSON.
 */
export function runMarketModelOnce() {
  ensureTables();
  const startedAt = Date.now();
  const rawRows = getMainJobRows();
  const listings = dedupeToUniqueFlats(rawRows, startedAt);
  const evaluation = evaluateModel(listings);
  const hedonic = trainHedonicModel(listings);
  const field = trainResidualField(listings, hedonic);
  const runId = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
  const scored = listings.map((listing) => scoreListing(listing, hedonic, field));
  const surfaceCells = buildSurfaceCells(listings, hedonic, field);

  const metrics = {
    globalMedianPricePerSqm: roundMetric(Math.exp(hedonic.baselineLog)),
    monthOffsetsLog: hedonic.monthOffsets.map(roundMetric),
    medianAbsoluteError: median(scored.map((row) => Math.abs(row.residualPricePerSqm))) || 0,
    surfaceCells: surfaceCells.length,
    rawRows: rawRows.length,
    uniqueFlats: listings.length,
    swapExcluded: rawRows.swapExcluded,
    hedonic: hedonic.coefficientSummary,
    evaluation,
  };

  persistRun({ runId, startedAt, listings, scored, surfaceCells, metrics, hedonic });

  try {
    writeSurfaceGeojson(surfaceCells);
  } catch (error) {
    logger.error('surface geojson write failed (map layer will be stale)', error);
  }

  logger.info(
    'market model run: ' +
      JSON.stringify({
        runId,
        modelVersion: MODEL_VERSION,
        rawRows: rawRows.length,
        uniqueFlats: listings.length,
        scoredRows: scored.length,
        surfaceCells: surfaceCells.length,
        medianColdPricePerSqm: roundMetric(Math.exp(hedonic.baselineLog)),
        holdoutMdape: evaluation.holdout?.mdape ?? null,
        holdoutPpe10: evaluation.holdout?.ppe10 ?? null,
        spatialCvMdape: evaluation.spatialCV?.mdape ?? null,
        naiveMdape: evaluation.naive?.mdape ?? null,
        durationMs: Date.now() - startedAt,
      }),
  );
}

/* --------------------------------- data --------------------------------- */

function getMainJobRows() {
  if (!tableExists('listings')) return Object.assign([], { swapExcluded: 0 });
  const cacheJoin = tableExists('homeserver_geocode_cache')
    ? `LEFT JOIN homeserver_geocode_cache c
        ON c.address_key = homeserver_address_key(l.address)`
    : `LEFT JOIN (SELECT NULL AS address_key, NULL AS accuracy, NULL AS status WHERE 0) c
        ON c.address_key = homeserver_address_key(l.address)`;
  const hasAttributes = tableExists('listing_attributes');
  const attrsJoin = hasAttributes ? `LEFT JOIN listing_attributes a ON a.listing_id = l.id` : '';
  const attrsSelect = hasAttributes
    ? `, a.parsed_at AS attrs_parsed_at, a.cold_rent_eur AS attr_cold_rent_eur,
       a.warm_rent_eur AS attr_warm_rent_eur, a.service_charges_eur AS attr_service_charges_eur,
       a.heating_costs_eur AS attr_heating_costs_eur, a.deposit_eur AS attr_deposit_eur,
       a.price_type AS attr_price_type, a.rooms AS attr_rooms, a.floor AS attr_floor,
       a.building_year AS attr_building_year, a.property_type AS attr_property_type,
       a.energy_class AS attr_energy_class, a.pets_allowed AS attr_pets_allowed,
       a.available_from AS attr_available_from, a.swap AS attr_swap, a.features_json AS attr_features_json`
    : '';
  // Blacklisted listings (WG rooms, furnished, temporary, ...) are stored for
  // completeness but priced on a different market — keep them out of training.
  const blacklistFilter = columnExists('listings', 'hidden_reason')
    ? `AND (l.hidden_reason IS NULL OR l.hidden_reason != 'blacklist')`
    : '';
  const rows = db
    .prepare(
      `
      SELECT
        l.id, l.created_at, l.price, l.size, l.rooms, l.title, l.description,
        l.address, l.link, l.provider, l.job_id, l.latitude, l.longitude,
        l.manually_deleted,
        COALESCE(c.accuracy, c.status, '') AS geocode_quality
        ${attrsSelect}
      FROM listings l
      JOIN jobs j ON j.id = l.job_id
      ${cacheJoin}
      ${attrsJoin}
      WHERE json_array_length(j.notification_adapter) > 0
        ${blacklistFilter}
        AND l.price IS NOT NULL AND l.price > 0
        AND l.size IS NOT NULL AND l.size BETWEEN 10 AND 400
        AND l.latitude IS NOT NULL AND l.longitude IS NOT NULL
        AND l.latitude != -1 AND l.longitude != -1
      `,
    )
    .all();

  const kept = [];
  let swapExcluded = 0;
  for (const row of rows) {
    // Use the attributes persisted at scrape time; re-parse only legacy rows
    // without a listing_attributes entry.
    const attrs = row.attrs_parsed_at != null ? storedAttrs(row) : parseListingAttrs(row);
    if (attrs.swap) {
      swapExcluded += 1;
      continue;
    }
    kept.push({ ...row, attrs });
  }
  return Object.assign(kept, { swapExcluded });
}

/**
 * Reconstruct the parseListingAttrs shape from a joined listing_attributes
 * row (columns prefixed by the SELECT above).
 *
 * @param {object} row
 * @returns {object}
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
    floor: row.attr_floor,
    buildingYear: row.attr_building_year,
    propertyType: row.attr_property_type,
    energyClass: row.attr_energy_class,
    petsAllowed: row.attr_pets_allowed == null ? null : Boolean(row.attr_pets_allowed),
    availableFrom: row.attr_available_from,
    swap: Boolean(row.attr_swap),
    features,
  };
}

/*
 * Collapse to one row per flat, regardless of job or portal:
 * 1. same link -> newest version wins (a portal edit re-inserts the ad with a
 *    new hash; the latest price is the current market offer);
 * 2. same trusted geocode point + same size + price within ±2% -> the row
 *    with the richest data wins (known cold rent beats unknown, then newer).
 */
function dedupeToUniqueFlats(rows, now) {
  const byLink = new Map();
  for (const row of rows) {
    const key = row.link || `no-link:${row.id}`;
    const existing = byLink.get(key);
    if (!existing || row.created_at > existing.created_at) byLink.set(key, row);
  }

  const clusters = new Map();
  const result = [];
  for (const row of byLink.values()) {
    const trusted = TRUSTED_ACCURACIES.has(row.geocode_quality);
    if (!trusted) {
      result.push(row);
      continue;
    }
    const cellKey = `${Number(row.latitude).toFixed(DUPLICATE_COORD_DECIMALS)}:${Number(row.longitude).toFixed(
      DUPLICATE_COORD_DECIMALS,
    )}:${row.size}`;
    const bucket = clusters.get(cellKey);
    if (!bucket) {
      clusters.set(cellKey, [row]);
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
  for (const bucket of clusters.values()) result.push(...bucket);

  return result
    .map((row) => enrichListing(row, now))
    .filter((listing) => listing.pricePerSqm >= 3 && listing.pricePerSqm <= 150);
}

function richness(row) {
  return (row.attrs.coldRentEur != null ? 10 : 0) + (row.attrs.rooms != null ? 1 : 0) + row.created_at / 1e15;
}

function enrichListing(row, now) {
  const attrs = row.attrs;
  const size = Number(row.size);
  const targetRent = attrs.coldRentEur ?? Number(row.price);
  const priceType = attrs.coldRentEur != null ? 'cold' : attrs.priceType;
  const rooms = attrs.rooms;
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);
  const projected = projectMeters(latitude, longitude);
  const createdAt = Number.isFinite(Number(row.created_at)) ? Number(row.created_at) : now;
  const ageDays = Math.max(0, (now - createdAt) / (24 * 60 * 60 * 1000));
  const address = normalizeAddress(row.address);
  const features = attrs.features ?? textFeatureFlags(row.title, row.description, address);

  return {
    id: row.id,
    link: row.link,
    provider: row.provider,
    title: row.title,
    createdAt,
    ageDays,
    monthOffset: Math.min(Math.floor(ageDays / DAYS_PER_MONTH), MAX_MONTH_OFFSETS),
    recencyWeight: Math.max(MIN_RECENCY_WEIGHT, Math.exp(-Math.LN2 * (ageDays / RECENCY_HALF_LIFE_DAYS))),
    price: Number(row.price),
    targetRent,
    priceType,
    size,
    rooms,
    floor: attrs.floor,
    buildingYear: attrs.buildingYear,
    propertyType: attrs.propertyType,
    latitude,
    longitude,
    x: projected.x,
    y: projected.y,
    pricePerSqm: targetRent / size,
    logPricePerSqm: Math.log(targetRent / size),
    area: inferArea(address),
    sizeBand: sizeBand(size),
    roomsBand: roomsBand(rooms),
    geoCell: gridKey(projected.x, projected.y, SURFACE_CELL_M),
    geocodeQuality: row.geocode_quality || 'unknown',
    isHidden: Number(row.manually_deleted) === 1,
    features,
    attrs,
  };
}

/* ------------------------------- hedonic -------------------------------- */

function trainHedonicModel(listings) {
  const dimensions = hedonicDimensions();
  let beta = new Array(dimensions).fill(0);
  const rows = listings.map((listing) => ({
    x: hedonicDesignVector(listing),
    y: listing.logPricePerSqm,
    w: listing.recencyWeight,
  }));

  if (rows.length) {
    beta[0] = median(rows.map((row) => row.y)) || 0;
    for (let pass = 0; pass < 3; pass += 1) {
      const residuals = rows.map((row) => row.y - dot(row.x, beta));
      const scale = 1.4826 * (median(residuals.map(Math.abs)) || 0.1);
      const weights = rows.map(
        (row, i) => row.w * Math.min(1, (1.345 * scale) / Math.max(Math.abs(residuals[i]), 1e-9)),
      );
      beta = solveWeightedRidge(rows, weights, dimensions);
    }
  }

  // Scoring and surface predictions are "at time zero": month dummies off.
  const predictNow = (listing) => dot(hedonicDesignVector({ ...listing, monthOffset: 0 }), beta);
  const predictAtOwnTime = (listing) => dot(hedonicDesignVector(listing), beta);

  const termNames = hedonicTermNames();
  return {
    beta,
    predictNow,
    predictAtOwnTime,
    baselineLog: beta[0],
    monthOffsets: beta.slice(dimensions - MAX_MONTH_OFFSETS),
    coefficientSummary: Object.fromEntries(termNames.map((name, index) => [name, roundMetric(beta[index])])),
  };
}

function solveWeightedRidge(rows, weights, dimensions) {
  const xtwx = Array.from({ length: dimensions }, () => new Array(dimensions).fill(0));
  const xtwy = new Array(dimensions).fill(0);
  rows.forEach((row, index) => {
    const w = weights[index];
    for (let i = 0; i < dimensions; i += 1) {
      xtwy[i] += w * row.x[i] * row.y;
      for (let j = i; j < dimensions; j += 1) {
        xtwx[i][j] += w * row.x[i] * row.x[j];
      }
    }
  });
  // Everything except the intercept is penalized — including the month
  // offsets, so short-window drift estimates stay bounded.
  for (let i = 0; i < dimensions; i += 1) {
    for (let j = 0; j < i; j += 1) {
      xtwx[i][j] = xtwx[j][i];
    }
    xtwx[i][i] += i > 0 ? RIDGE_LAMBDA : 1e-9;
  }
  return solveLinearSystem(xtwx, xtwy);
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    [a[column], a[pivot]] = [a[pivot], a[column]];
    const head = a[column][column];
    if (Math.abs(head) < 1e-12) continue;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = a[row][column] / head;
      for (let k = column; k <= n; k += 1) {
        a[row][k] -= factor * a[column][k];
      }
    }
  }
  return a.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

/* ---------------------------- residual field ----------------------------- */

function trainResidualField(listings, hedonic) {
  const observations = listings.map((listing) => ({
    id: listing.id,
    x: listing.x,
    y: listing.y,
    weight: listing.recencyWeight,
    residualLog: listing.logPricePerSqm - hedonic.predictAtOwnTime(listing),
  }));
  const index = new Map();
  for (const observation of observations) {
    const key = gridKey(observation.x, observation.y, INDEX_CELL_M);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(observation);
  }
  return { index };
}

function predictFieldAt(x, y, field, excludedListingId = null) {
  const candidates = spatialCandidates(x, y, field.index, SEARCH_RADIUS_M, excludedListingId);
  const samples250m = candidates.filter((candidate) => candidate.distanceM <= 250).length;
  const samples500m = candidates.filter((candidate) => candidate.distanceM <= 500).length;
  const samples1000m = candidates.filter((candidate) => candidate.distanceM <= 1000).length;
  const empty = {
    residualLog: 0,
    confidence: 0.05,
    bandwidthM: MAX_BANDWIDTH_M,
    spreadLog: MIN_LOG_SPREAD * 4,
    effectiveSamples: 0,
    samples250m,
    samples500m,
    samples1000m,
    points: [],
  };
  if (!candidates.length) return empty;

  candidates.sort((a, b) => a.distanceM - b.distanceM);
  const knnDistance = candidates[Math.min(KERNEL_NEIGHBORS, candidates.length) - 1].distanceM;
  const bandwidthM = Math.max(MIN_BANDWIDTH_M, Math.min(MAX_BANDWIDTH_M, knnDistance));
  const points = candidates
    .filter((candidate) => candidate.distanceM <= 3 * bandwidthM)
    .map((candidate) => ({
      value: candidate.residualLog,
      weight: candidate.weight * gaussianWeight(candidate.distanceM, bandwidthM),
    }));
  const residualLog = weightedQuantile(points, 0.5);
  if (residualLog == null) return empty;

  const effectiveSamples = effectiveSampleSize(points);
  const spreadLog = Math.max(
    MIN_LOG_SPREAD,
    (weightedQuantile(points, 0.75) ?? 0) - (weightedQuantile(points, 0.25) ?? 0),
  );
  const confidence = clamp(Math.min(1, effectiveSamples / 12) * Math.sqrt(MIN_BANDWIDTH_M / bandwidthM), 0.05, 1);

  return {
    residualLog,
    confidence,
    bandwidthM,
    spreadLog,
    effectiveSamples,
    samples250m,
    samples500m,
    samples1000m,
    points,
  };
}

function spatialCandidates(x, y, index, radiusM, excludedListingId) {
  const radiusCells = Math.ceil(radiusM / INDEX_CELL_M);
  const baseCellX = Math.floor(x / INDEX_CELL_M);
  const baseCellY = Math.floor(y / INDEX_CELL_M);
  const candidates = [];
  for (let cellX = baseCellX - radiusCells; cellX <= baseCellX + radiusCells; cellX += 1) {
    for (let cellY = baseCellY - radiusCells; cellY <= baseCellY + radiusCells; cellY += 1) {
      for (const observation of index.get(`${cellX}:${cellY}`) || []) {
        if (observation.id === excludedListingId) continue;
        const distanceM = Math.hypot(observation.x - x, observation.y - y);
        if (distanceM <= radiusM) candidates.push({ ...observation, distanceM });
      }
    }
  }
  return candidates;
}

/* -------------------------------- scoring -------------------------------- */

function scoreListing(listing, hedonic, field) {
  const surface = predictFieldAt(listing.x, listing.y, field, listing.id);
  const predictedLog = hedonic.predictNow(listing) + surface.residualLog;
  const prediction = Math.max(1, Math.exp(predictedLog));
  const residual = listing.pricePerSqm - prediction;
  const delta = residual / prediction;
  const geocodePenalty = TRUSTED_ACCURACIES.has(listing.geocodeQuality) ? 1 : 0.75;
  const confidence = clamp(surface.confidence * geocodePenalty, 0.05, 1);

  // z > 0 = cheaper than the local market, in units of local dispersion.
  const ownResidualLog = listing.logPricePerSqm - hedonic.predictAtOwnTime(listing);
  const zScore = (predictedLog - listing.logPricePerSqm) / surface.spreadLog;

  // Weighted share of local comps whose residual is below this listing's:
  // percentile 8 = "cheaper than 92% of comparable flats around it".
  let percentile = null;
  if (surface.points.length >= 4) {
    const totalWeight = surface.points.reduce((sum, point) => sum + point.weight, 0);
    if (totalWeight > 0) {
      const below = surface.points.reduce((sum, point) => sum + (point.value < ownResidualLog ? point.weight : 0), 0);
      percentile = (100 * below) / totalWeight;
    }
  }

  return {
    listingId: listing.id,
    createdAt: listing.createdAt,
    provider: listing.provider,
    link: listing.link,
    title: listing.title,
    isHidden: listing.isHidden ? 1 : 0,
    actualPriceEur: roundMetric(listing.price),
    targetRentEur: roundMetric(listing.targetRent),
    priceType: listing.priceType,
    sizeSqm: roundMetric(listing.size),
    rooms: listing.rooms,
    actualPricePerSqm: roundMetric(listing.pricePerSqm),
    predictedPricePerSqm: roundMetric(prediction),
    residualPricePerSqm: roundMetric(residual),
    deltaPercent: roundMetric(delta * 100),
    zScore: roundMetric(zScore),
    percentile: roundMetric(percentile),
    confidence: roundMetric(confidence),
    nearbyComps250m: surface.samples250m,
    nearbyComps500m: surface.samples500m,
    nearbyComps1000m: surface.samples1000m,
    geoCell: listing.geoCell,
    area: listing.area,
    sizeBand: listing.sizeBand,
    roomsBand: listing.roomsBand,
    featureFlagsJson: JSON.stringify(listing.features),
    geocodeQuality: listing.geocodeQuality,
  };
}

function buildSurfaceCells(listings, hedonic, field) {
  const cellKeys = new Set();
  for (const listing of listings) {
    const cellX = Math.floor(listing.x / SURFACE_CELL_M);
    const cellY = Math.floor(listing.y / SURFACE_CELL_M);
    for (let x = cellX - SURFACE_CELL_MARGIN; x <= cellX + SURFACE_CELL_MARGIN; x += 1) {
      for (let y = cellY - SURFACE_CELL_MARGIN; y <= cellY + SURFACE_CELL_MARGIN; y += 1) {
        cellKeys.add(`${x}:${y}`);
      }
    }
  }

  const rows = [];
  for (const key of cellKeys) {
    const [cellX, cellY] = key.split(':').map(Number);
    const x = (cellX + 0.5) * SURFACE_CELL_M;
    const y = (cellY + 0.5) * SURFACE_CELL_M;
    const surface = predictFieldAt(x, y, field);
    if (surface.confidence < config.surfaceMinConfidence) continue;
    const center = unprojectMeters(x, y);
    rows.push({
      cellId: `${SURFACE_CELL_M}m:${key}`,
      cellSizeM: SURFACE_CELL_M,
      centerLatitude: roundMetric(center.latitude),
      centerLongitude: roundMetric(center.longitude),
      predictedPricePerSqm: roundMetric(Math.exp(hedonic.baselineLog + surface.residualLog)),
      confidence: roundMetric(surface.confidence),
      samples250m: surface.samples250m,
      samples500m: surface.samples500m,
      samples1000m: surface.samples1000m,
      effectiveSamples: roundMetric(surface.effectiveSamples),
      surfaceComponentsJson: JSON.stringify({
        residualLog: roundMetric(surface.residualLog),
        spreadLog: roundMetric(surface.spreadLog),
        bandwidthM: roundMetric(surface.bandwidthM),
      }),
    });
  }
  return rows;
}

/*
 * Choropleth layer for the Grafana geomap: the 125m surface cells as real
 * polygons (fully tiling blocks), served by Grafana from a read-only mount
 * of the surface directory next to the database. Written atomically so
 * Grafana never reads a half file.
 */
function writeSurfaceGeojson(surfaceCells) {
  const dir = path.join(path.dirname(config.dbPath), 'surface');
  fs.mkdirSync(dir, { recursive: true });
  const features = surfaceCells.map((row) => {
    const [, cellX, cellY] = row.cellId.split(':');
    const x0 = Number(cellX) * SURFACE_CELL_M;
    const y0 = Number(cellY) * SURFACE_CELL_M;
    const ring = [
      [x0, y0],
      [x0 + SURFACE_CELL_M, y0],
      [x0 + SURFACE_CELL_M, y0 + SURFACE_CELL_M],
      [x0, y0 + SURFACE_CELL_M],
      [x0, y0],
    ].map(([x, y]) => {
      const point = unprojectMeters(x, y);
      return [Math.round(point.longitude * 1e6) / 1e6, Math.round(point.latitude * 1e6) / 1e6];
    });
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        price: Math.round(row.predictedPricePerSqm * 100) / 100,
        confidence: Math.round(row.confidence * 100) / 100,
        comps500m: row.samples500m,
        fill: surfaceFillColor(row.predictedPricePerSqm),
        'fill-opacity': 0.62,
        stroke: '#ffffff',
        'stroke-width': 0.35,
      },
    };
  });
  const tmpPath = path.join(dir, 'surface.geojson.tmp');
  fs.writeFileSync(tmpPath, JSON.stringify({ type: 'FeatureCollection', features }));
  fs.renameSync(tmpPath, path.join(dir, 'surface.geojson'));
}

function surfaceFillColor(pricePerSqm) {
  const colorStops = [
    { value: 8, color: [26, 150, 80] },
    { value: 21.5, color: [254, 224, 139] },
    { value: 35, color: [215, 48, 39] },
  ];
  const price = clamp(pricePerSqm, colorStops[0].value, colorStops.at(-1).value);
  const upperIndex = colorStops.findIndex((stop) => price <= stop.value);
  const upper = colorStops[upperIndex];
  const lower = colorStops[Math.max(0, upperIndex - 1)];
  const progress = lower === upper ? 0 : (price - lower.value) / (upper.value - lower.value);
  const channels = lower.color.map((channel, index) => Math.round(channel + (upper.color[index] - channel) * progress));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/* ------------------------------- evaluation ------------------------------ */

/*
 * Honest error estimates BEFORE the production fit:
 * - naive: predict the recency-weighted global median (the floor to beat)
 * - holdout: newest 20% by created_at, model fitted on the older 80%
 * - spatialCV: 5 folds blocked by 500m grid cell, so a fold's flats cannot
 *   be predicted from their own building (random CV would leak location)
 */
function evaluateModel(listings) {
  if (listings.length < MIN_HOLDOUT_ROWS * 2) {
    return { skipped: `only ${listings.length} rows` };
  }

  const naiveMedian = weightedQuantile(
    listings.map((listing) => ({ value: listing.pricePerSqm, weight: listing.recencyWeight })),
    0.5,
  );
  const naive = errorStats(listings.map((listing) => ({ actual: listing.pricePerSqm, predicted: naiveMedian })));

  const sorted = [...listings].sort((a, b) => a.createdAt - b.createdAt);
  const testSize = Math.max(MIN_HOLDOUT_ROWS, Math.floor(sorted.length * HOLDOUT_FRACTION));
  const train = sorted.slice(0, sorted.length - testSize);
  const test = sorted.slice(sorted.length - testSize);
  const holdout = { ...evaluateSplit(train, test), n: test.length };

  const folds = Array.from({ length: SPATIAL_CV_FOLDS }, () => []);
  for (const listing of listings) {
    folds[foldOf(listing)].push(listing);
  }
  const cvPairs = [];
  for (let fold = 0; fold < SPATIAL_CV_FOLDS; fold += 1) {
    if (!folds[fold].length) continue;
    const cvTrain = listings.filter((listing) => foldOf(listing) !== fold);
    cvPairs.push(...predictSplit(cvTrain, folds[fold]));
  }
  const spatialCV = { ...errorStats(cvPairs), n: cvPairs.length };

  return { naive, holdout, spatialCV };
}

function foldOf(listing) {
  const key = gridKey(listing.x, listing.y, SPATIAL_CV_CELL_M);
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % SPATIAL_CV_FOLDS;
}

function evaluateSplit(train, test) {
  return errorStats(predictSplit(train, test));
}

function predictSplit(train, test) {
  const hedonic = trainHedonicModel(train);
  const field = trainResidualField(train, hedonic);
  return test.map((listing) => {
    const surface = predictFieldAt(listing.x, listing.y, field);
    // Predict at the listing's own time so holdout error measures the model,
    // not the drift between train and test windows.
    const predicted = Math.max(1, Math.exp(hedonic.predictAtOwnTime(listing) + surface.residualLog));
    return { actual: listing.pricePerSqm, predicted };
  });
}

function errorStats(pairs) {
  const percentageErrors = pairs
    .filter((pair) => Number.isFinite(pair.actual) && Number.isFinite(pair.predicted) && pair.actual > 0)
    .map((pair) => Math.abs(pair.predicted - pair.actual) / pair.actual);
  if (!percentageErrors.length) return { mdape: null, ppe10: null };
  return {
    mdape: roundMetric(100 * (median(percentageErrors) ?? 0)),
    ppe10: roundMetric((100 * percentageErrors.filter((error) => error <= 0.1).length) / percentageErrors.length),
  };
}

/* ------------------------------ persistence ------------------------------ */

function persistRun({ runId, startedAt, scored, surfaceCells, metrics, hedonic }) {
  const insertRun = db.prepare(
    `INSERT INTO homeserver_model_runs (id, model_version, training_rows, scored_rows, created_at, metrics_json)
     VALUES (@id, @modelVersion, @trainingRows, @scoredRows, @createdAt, @metricsJson)`,
  );
  const insertScore = db.prepare(
    `INSERT INTO homeserver_listing_market_model (
      listing_id, run_id, model_version, created_at, listing_created_at, provider, link, title, is_hidden,
      actual_price_eur, target_rent_eur, price_type, size_sqm, rooms,
      actual_price_per_sqm, predicted_price_per_sqm, residual_price_per_sqm, delta_percent,
      z_score, percentile, confidence, nearby_comps_250m, nearby_comps_500m, nearby_comps_1000m,
      geo_cell, area, size_band, rooms_band, feature_flags_json, geocode_quality
    ) VALUES (
      @listingId, @runId, @modelVersion, @createdAt, @listingCreatedAt, @provider, @link, @title, @isHidden,
      @actualPriceEur, @targetRentEur, @priceType, @sizeSqm, @rooms,
      @actualPricePerSqm, @predictedPricePerSqm, @residualPricePerSqm, @deltaPercent,
      @zScore, @percentile, @confidence, @nearbyComps250m, @nearbyComps500m, @nearbyComps1000m,
      @geoCell, @area, @sizeBand, @roomsBand, @featureFlagsJson, @geocodeQuality
    )`,
  );
  const insertSurfaceCell = db.prepare(
    `INSERT INTO homeserver_market_surface_cells (
      cell_id, run_id, model_version, created_at, cell_size_m,
      center_latitude, center_longitude, predicted_price_per_sqm, confidence,
      samples_250m, samples_500m, samples_1000m, effective_samples, surface_components_json
    ) VALUES (
      @cellId, @runId, @modelVersion, @createdAt, @cellSizeM,
      @centerLatitude, @centerLongitude, @predictedPricePerSqm, @confidence,
      @samples250m, @samples500m, @samples1000m, @effectiveSamples, @surfaceComponentsJson
    )`,
  );
  const upsertState = db.prepare(
    `INSERT INTO homeserver_model_state (id, run_id, model_version, created_at, state_json)
     VALUES (1, @runId, @modelVersion, @createdAt, @stateJson)
     ON CONFLICT(id) DO UPDATE SET
       run_id = excluded.run_id, model_version = excluded.model_version,
       created_at = excluded.created_at, state_json = excluded.state_json`,
  );

  db.transaction(() => {
    insertRun.run({
      id: runId,
      modelVersion: MODEL_VERSION,
      trainingRows: metrics.uniqueFlats,
      scoredRows: scored.length,
      createdAt: startedAt,
      metricsJson: JSON.stringify(metrics),
    });
    db.prepare(`DELETE FROM homeserver_listing_market_model`).run();
    db.prepare(`DELETE FROM homeserver_market_surface_cells`).run();
    db.prepare(`DELETE FROM homeserver_model_runs WHERE created_at < @cutoff`).run({
      cutoff: startedAt - RUN_RETENTION_MS,
    });
    for (const row of scored) {
      insertScore.run({
        ...row,
        runId,
        modelVersion: MODEL_VERSION,
        createdAt: startedAt,
        listingCreatedAt: row.createdAt,
      });
    }
    for (const row of surfaceCells) {
      insertSurfaceCell.run({ ...row, runId, modelVersion: MODEL_VERSION, createdAt: startedAt });
    }
    upsertState.run({
      runId,
      modelVersion: MODEL_VERSION,
      createdAt: startedAt,
      stateJson: JSON.stringify({
        beta: hedonic.beta,
        baselineLog: hedonic.baselineLog,
        surfaceCellSizeM: SURFACE_CELL_M,
        metersPerLatitudeDegree: METERS_PER_LATITUDE_DEGREE,
        metersPerLongitudeDegree: METERS_PER_LONGITUDE_DEGREE,
      }),
    });
  })();
}

/**
 * Latest run summary row (or null when no run exists yet). Used by the CLI
 * status mode and container healthchecks.
 *
 * @returns {object|null}
 */
export function getMarketModelStatus() {
  ensureTables();
  const row = db
    .prepare(
      `SELECT r.*, count(m.listing_id) AS predictions
       FROM homeserver_model_runs r
       LEFT JOIN homeserver_listing_market_model m ON m.run_id = r.id
       GROUP BY r.id ORDER BY r.created_at DESC LIMIT 1`,
    )
    .get();
  return row || null;
}

/*
 * Tables are owned by migration 22 in the main app; this keeps the daemon
 * self-sufficient when it races a fresh database that has not been migrated
 * yet, and drops the pre-v3 per-listing shape once.
 */
function ensureTables() {
  if (tableExists('homeserver_listing_market_model') && !columnExists('homeserver_listing_market_model', 'z_score')) {
    db.exec(`DROP TABLE homeserver_listing_market_model`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS homeserver_model_runs (
      id TEXT PRIMARY KEY,
      model_version TEXT NOT NULL,
      training_rows INTEGER NOT NULL,
      scored_rows INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      metrics_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS homeserver_listing_market_model (
      listing_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      listing_created_at INTEGER,
      provider TEXT,
      link TEXT,
      title TEXT,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      actual_price_eur REAL NOT NULL,
      target_rent_eur REAL,
      price_type TEXT,
      size_sqm REAL NOT NULL,
      rooms REAL,
      actual_price_per_sqm REAL NOT NULL,
      predicted_price_per_sqm REAL NOT NULL,
      residual_price_per_sqm REAL NOT NULL,
      delta_percent REAL NOT NULL,
      z_score REAL,
      percentile REAL,
      confidence REAL NOT NULL,
      nearby_comps_250m INTEGER NOT NULL,
      nearby_comps_500m INTEGER NOT NULL,
      nearby_comps_1000m INTEGER NOT NULL,
      geo_cell TEXT NOT NULL,
      area TEXT NOT NULL,
      size_band TEXT NOT NULL,
      rooms_band TEXT NOT NULL,
      feature_flags_json TEXT NOT NULL,
      geocode_quality TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES homeserver_model_runs (id)
    );

    CREATE INDEX IF NOT EXISTS idx_homeserver_listing_market_model_delta
      ON homeserver_listing_market_model (delta_percent ASC);
    CREATE INDEX IF NOT EXISTS idx_homeserver_listing_market_model_area
      ON homeserver_listing_market_model (area, rooms_band, size_band);

    CREATE TABLE IF NOT EXISTS homeserver_market_surface_cells (
      cell_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      cell_size_m INTEGER NOT NULL,
      center_latitude REAL NOT NULL,
      center_longitude REAL NOT NULL,
      predicted_price_per_sqm REAL NOT NULL,
      confidence REAL NOT NULL,
      samples_250m INTEGER NOT NULL,
      samples_500m INTEGER NOT NULL,
      samples_1000m INTEGER NOT NULL,
      effective_samples REAL NOT NULL,
      surface_components_json TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES homeserver_model_runs (id)
    );

    CREATE INDEX IF NOT EXISTS idx_homeserver_market_surface_cells_confidence
      ON homeserver_market_surface_cells (confidence DESC);

    CREATE TABLE IF NOT EXISTS homeserver_model_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      run_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      state_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_homeserver_model_runs_created_at
      ON homeserver_model_runs (created_at DESC);
  `);
}

function tableExists(name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

function columnExists(table, column) {
  return db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column) !== undefined;
}

/* -------------------------------- helpers -------------------------------- */

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function weightedQuantile(points, q) {
  const rows = points.filter(
    (point) => Number.isFinite(point.value) && Number.isFinite(point.weight) && point.weight > 0,
  );
  if (!rows.length) return null;
  rows.sort((a, b) => a.value - b.value);
  const total = rows.reduce((sum, point) => sum + point.weight, 0);
  let seen = 0;
  for (const point of rows) {
    seen += point.weight;
    if (seen >= total * q) return point.value;
  }
  return rows.at(-1).value;
}

function effectiveSampleSize(points) {
  const rows = points.filter((point) => Number.isFinite(point.weight) && point.weight > 0);
  if (!rows.length) return 0;
  const sum = rows.reduce((total, point) => total + point.weight, 0);
  const sumSquares = rows.reduce((total, point) => total + point.weight ** 2, 0);
  return sumSquares > 0 ? sum ** 2 / sumSquares : 0;
}

function gaussianWeight(distanceM, bandwidthM) {
  return Math.exp(-0.5 * (distanceM / bandwidthM) ** 2);
}

function gridKey(x, y, sizeM) {
  return `${Math.floor(x / sizeM)}:${Math.floor(y / sizeM)}`;
}

function projectMeters(latitude, longitude) {
  return {
    x: longitude * METERS_PER_LONGITUDE_DEGREE,
    y: latitude * METERS_PER_LATITUDE_DEGREE,
  };
}

function unprojectMeters(x, y) {
  return {
    latitude: y / METERS_PER_LATITUDE_DEGREE,
    longitude: x / METERS_PER_LONGITUDE_DEGREE,
  };
}

function sizeBand(size) {
  if (!Number.isFinite(size)) return 'unknown';
  if (size < 40) return 'lt40';
  if (size < 60) return '40_59';
  if (size < 80) return '60_79';
  if (size < 100) return '80_99';
  return '100_plus';
}

function roomsBand(rooms) {
  if (!Number.isFinite(rooms)) return 'unknown';
  if (rooms <= 1) return '1';
  if (rooms <= 1.5) return '1_5';
  if (rooms <= 2) return '2';
  if (rooms <= 3) return '3';
  if (rooms <= 4) return '4';
  return '5_plus';
}

function inferArea(address) {
  const normalized = address
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

function roundMetric(value) {
  return Number.isFinite(value) ? Math.round(value * 1000000) / 1000000 : null;
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
