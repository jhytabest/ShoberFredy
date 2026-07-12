/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Pre-save market scoring.
 *
 * The market model retrains daily, but a brand-new listing is priced BEFORE
 * it is saved: the pipeline's _enrich stage calls scoreListingNow with the
 * freshly parsed attributes, and the resulting score is persisted by
 * storeListings in the same transaction as the listing row
 * (homeserver_listing_scores). The scoring decomposition is exactly the one
 * the model itself uses: hedonic coefficients (homeserver_model_state) plus
 * the local residual surface cell (homeserver_market_surface_cells).
 *
 * At notification time, notify.js renders the score carried on the listing
 * as a metrics line appended to the address field (formatScoreLine).
 *
 * Fails open everywhere: no model state or no nearby surface cell → the
 * listing stays unscored and is notified undecorated.
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { addressKey } from '../geocoding/address.js';
import { parseListingAttrs } from './listingAttrs.js';
import { hedonicDesignVector, textFeatureFlags, dot, clamp } from './hedonicFeatures.js';

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
 * @param {object} [precomputedAttrs] parseListingAttrs output (with a
 *   `features` map) when the caller already extracted it — avoids re-parsing.
 * @returns {object|null}
 */
export function scoreListingNow(listing, precomputedAttrs = null) {
  const db = SqliteConnection.getConnection();
  const state = getState(db);
  if (!state || !Array.isArray(state.beta)) return null;

  const price = Number(listing.price);
  const size = Number(listing.size);
  const lat = Number(listing.latitude);
  const lng = Number(listing.longitude);
  if (!(price > 0) || !(size >= 10 && size <= 400)) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === -1 || lng === -1) return null;

  const attrs = precomputedAttrs ?? parseListingAttrs(listing);
  const targetRent = attrs.coldRentEur ?? price;
  const priceType = attrs.coldRentEur != null ? 'cold' : attrs.priceType;
  const actualPricePerSqm = targetRent / size;
  if (actualPricePerSqm < 3 || actualPricePerSqm > 150) return null;

  const features = attrs.features ?? textFeatureFlags(listing.title, listing.description, listing.address);
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
