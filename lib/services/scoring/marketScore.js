/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Save-time market scoring.
 *
 * The market model (tools/market/marketModel.js) retrains daily, but a
 * brand-new listing is priced the moment it enters the database:
 * persistListingScores runs in the pipeline directly after save (for main and
 * shadow jobs alike) and reprices each listing from the persisted model state
 * — hedonic coefficients (homeserver_model_state) plus the local residual
 * surface cell (homeserver_market_surface_cells), the exact decomposition the
 * model itself uses. The score is written to homeserver_listing_scores.
 *
 * At notification time, decorateListingsForNotification reads that persisted
 * score (recomputing only if persistence failed) and appends a metrics line
 * to the listing's address field, which every notification adapter renders;
 * listings are already saved by this point, so the decoration never reaches
 * the listings table.
 *
 * Fails open everywhere: no model state, no nearby surface cell, or any
 * error → the listing stays unscored and is notified undecorated.
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { addressKey } from '../geocoding/address.js';
import { parseListingAttrs } from './listingAttrs.js';
import { hedonicDesignVector, textFeatureFlags, dot, clamp } from './hedonicFeatures.js';
import logger from '../logger.js';

const TRUSTED_ACCURACIES = new Set(['house', 'street']);
const MODEL_VERSION_PREFIX = 'geo-surface-v3';

function getState(db) {
  if (!SqliteConnection.tableExists('homeserver_model_state')) return null;
  const row = db.prepare(`SELECT model_version, created_at, state_json FROM homeserver_model_state WHERE id = 1`).get();
  if (!row || !row.model_version.startsWith(MODEL_VERSION_PREFIX)) return null;
  return { ...JSON.parse(row.state_json), createdAt: row.created_at };
}

function findSurfaceCell(db, state, x, y) {
  const cellSize = state.surfaceCellSizeM;
  const baseX = Math.floor(x / cellSize);
  const baseY = Math.floor(y / cellSize);
  const candidates = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      candidates.push(`${cellSize}m:${baseX + dx}:${baseY + dy}`);
    }
  }
  const rows = db
    .prepare(
      `SELECT cell_id, center_latitude, center_longitude, confidence, samples_500m, surface_components_json
       FROM homeserver_market_surface_cells
       WHERE cell_id IN (${candidates.map(() => '?').join(',')})`,
    )
    .all(...candidates);
  if (!rows.length) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const row of rows) {
    const cellX = row.center_longitude * state.metersPerLongitudeDegree;
    const cellY = row.center_latitude * state.metersPerLatitudeDegree;
    const distance = Math.hypot(cellX - x, cellY - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = row;
    }
  }
  return best;
}

function geocodeTrusted(db, address) {
  if (!address || !SqliteConnection.tableExists('homeserver_geocode_cache')) return false;
  const row = db
    .prepare(`SELECT accuracy FROM homeserver_geocode_cache WHERE address_key = ? AND status = 'ok'`)
    .get(addressKey(address));
  return Boolean(row && TRUSTED_ACCURACIES.has(row.accuracy));
}

/**
 * Price one listing against the persisted model. Returns null when the
 * listing cannot be scored (missing price/size/coords, no model state).
 *
 * @param {object} listing
 * @returns {object|null}
 */
export function scoreListingNow(listing) {
  const db = SqliteConnection.getConnection();
  const state = getState(db);
  if (!state || !Array.isArray(state.beta)) return null;

  const price = Number(listing.price);
  const size = Number(listing.size);
  const lat = Number(listing.latitude);
  const lng = Number(listing.longitude);
  if (!(price > 0) || !(size >= 10 && size <= 400)) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === -1 || lng === -1) return null;

  const attrs = parseListingAttrs(listing);
  const targetRent = attrs.coldRentEur ?? price;
  const priceType = attrs.coldRentEur != null ? 'cold' : attrs.priceType;
  const actualPricePerSqm = targetRent / size;
  if (actualPricePerSqm < 3 || actualPricePerSqm > 150) return null;

  const features = textFeatureFlags(listing.title, listing.description, listing.address);
  const design = hedonicDesignVector({
    size,
    rooms: attrs.rooms,
    floor: attrs.floor,
    buildingYear: attrs.buildingYear,
    propertyType: attrs.propertyType,
    priceType,
    features,
    monthOffset: 0,
  });
  const hedonicLog = dot(design, state.beta);

  const x = lng * state.metersPerLongitudeDegree;
  const y = lat * state.metersPerLatitudeDegree;
  const cell = findSurfaceCell(db, state, x, y);
  const components = cell ? JSON.parse(cell.surface_components_json) : { residualLog: 0, spreadLog: 0.2 };

  const predictedLog = hedonicLog + (components.residualLog ?? 0);
  const fairPricePerSqm = Math.max(1, Math.exp(predictedLog));
  const deltaPercent = (100 * (actualPricePerSqm - fairPricePerSqm)) / fairPricePerSqm;
  const spreadLog = Math.max(components.spreadLog ?? 0.2, 0.05);
  const zScore = (predictedLog - Math.log(actualPricePerSqm)) / spreadLog;
  const geocodePenalty = geocodeTrusted(db, listing.address) ? 1 : 0.75;
  const confidence = clamp((cell ? cell.confidence : 0.05) * geocodePenalty, 0.05, 1);

  return {
    actualPricePerSqm,
    fairPricePerSqm,
    deltaPercent,
    zScore,
    confidence,
    comps500m: cell ? cell.samples_500m : 0,
    priceType,
    swap: attrs.swap,
    modelCreatedAt: state.createdAt,
  };
}

/**
 * Human-readable one-line summary of a score for notifications.
 * @param {object} score
 * @returns {string}
 */
export function formatScoreLine(score) {
  const sign = (value) => (value >= 0 ? `+${value.toFixed(1)}` : value.toFixed(1));
  const rentKind = score.priceType === 'cold' ? 'cold' : score.priceType === 'warm' ? 'warm' : 'rent?';
  const swapNote = score.swap ? ' | SWAP LISTING' : '';
  return (
    `Model: ${score.actualPricePerSqm.toFixed(2)} €/m² vs fair ${score.fairPricePerSqm.toFixed(2)} €/m² ` +
    `(${sign(score.deltaPercent)}%) | z ${sign(score.zScore)} | conf ${score.confidence.toFixed(2)} | ` +
    `${score.comps500m} comps ≤500m | ${rentKind}${swapNote}`
  );
}

/**
 * Pipeline hook: score every saved listing (main and shadow jobs) against the
 * persisted model state and store the result. Runs directly after save, so a
 * listing is priced the moment it enters the database.
 *
 * @param {object[]} listings
 * @returns {object[]} the same listings, unchanged
 */
export function persistListingScores(listings) {
  if (!Array.isArray(listings) || listings.length === 0) return listings;
  try {
    const db = SqliteConnection.getConnection();
    if (!SqliteConnection.tableExists('homeserver_listing_scores')) return listings;
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO homeserver_listing_scores (
        listing_id, scored_at, model_created_at, actual_price_per_sqm, fair_price_per_sqm,
        delta_percent, z_score, confidence, comps_500m, price_type, swap
      ) VALUES (
        @listingId, @scoredAt, @modelCreatedAt, @actualPricePerSqm, @fairPricePerSqm,
        @deltaPercent, @zScore, @confidence, @comps500m, @priceType, @swap
      )
    `);
    db.transaction(() => {
      for (const listing of listings) {
        if (listing.id == null) continue;
        const score = scoreListingNow(listing);
        if (!score) continue;
        upsert.run({
          listingId: String(listing.id),
          scoredAt: Date.now(),
          modelCreatedAt: score.modelCreatedAt ?? null,
          actualPricePerSqm: score.actualPricePerSqm,
          fairPricePerSqm: score.fairPricePerSqm,
          deltaPercent: score.deltaPercent,
          zScore: score.zScore,
          confidence: score.confidence,
          comps500m: score.comps500m,
          priceType: score.priceType ?? null,
          swap: score.swap ? 1 : 0,
        });
      }
    })();
  } catch (error) {
    logger.warn('market score persistence failed; listings stay unscored this run', error);
  }
  return listings;
}

function getPersistedScore(listingId) {
  if (listingId == null) return null;
  const db = SqliteConnection.getConnection();
  if (!SqliteConnection.tableExists('homeserver_listing_scores')) return null;
  const row = db
    .prepare(
      `SELECT model_created_at, actual_price_per_sqm, fair_price_per_sqm, delta_percent,
              z_score, confidence, comps_500m, price_type, swap
       FROM homeserver_listing_scores WHERE listing_id = ?`,
    )
    .get(String(listingId));
  if (!row) return null;
  return {
    actualPricePerSqm: row.actual_price_per_sqm,
    fairPricePerSqm: row.fair_price_per_sqm,
    deltaPercent: row.delta_percent,
    zScore: row.z_score,
    confidence: row.confidence,
    comps500m: row.comps_500m,
    priceType: row.price_type,
    swap: Boolean(row.swap),
    modelCreatedAt: row.model_created_at,
  };
}

/**
 * Pipeline hook: decorate listings of notifying jobs with a metrics line.
 * Uses the score persisted at save time (recomputes only if that failed);
 * runs after save, so the decoration is notification-only.
 *
 * @param {object[]} listings
 * @param {{notificationAdapters: object[]}} options
 * @returns {object[]} the same listings, decorated in place
 */
export function decorateListingsForNotification(listings, { notificationAdapters }) {
  if (!Array.isArray(listings) || listings.length === 0) return listings;
  if (!Array.isArray(notificationAdapters) || notificationAdapters.length === 0) return listings;
  for (const listing of listings) {
    try {
      const score = getPersistedScore(listing.id) ?? scoreListingNow(listing);
      if (score) {
        listing.address = `${listing.address || ''}\n${formatScoreLine(score)}`;
      }
    } catch (error) {
      logger.warn(`market scoring failed for '${listing.title}'; notifying undecorated`, error);
    }
  }
  return listings;
}
