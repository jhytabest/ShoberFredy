/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Pre-save market scoring, dual-model.
 *
 * The market models retrain daily, but a brand-new listing is priced BEFORE
 * it is saved: the pipeline's _enrich stage calls scoreListingNow with the
 * freshly parsed attributes, and the resulting per-model scores are
 * persisted by storeListings in the same transaction as the listing row
 * (homeserver_listing_model_scores). BOTH families score every listing:
 *
 * - ridge: standardized hedonic coefficients + the local residual surface
 *   cell (homeserver_market_surface_cells), smearing included;
 * - gbm: the dumped LightGBM quantile trees evaluated in-process (pure JS).
 *
 * Both carry Mondrian split-conformal intervals keyed by the listing's
 * coordinate-quality tier — a listing without coordinates is still scored,
 * it just gets the honest 'missing'-tier interval.
 *
 * Artifacts are validated STRUCTURALLY (feature-vector length against the
 * artifact's coefficients/features), not by version-string comparison: an
 * artifact that no longer matches the code's feature space is skipped, and
 * the first retrain heals it.
 *
 * Fails open everywhere: no registry, no artifact, out-of-band input → the
 * affected model contributes null; if both are null the listing stays
 * unscored and is notified undecorated.
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { addressKey } from '../geocoding/address.js';
import { hedonicDesignVector, structuredFeatureFlags, gbmFeatureVector } from './hedonicFeatures.js';
import { coldEquivalentRent } from '../market/corpus.js';
import { conformalIntervalLog, coordQualityTier } from '../market/conformal.js';
import { loadModel } from '../market/modelRegistry.js';
import { hasUsableCoordinates } from '../market/geo.js';
import { prepareGbmArtifact, predictGbmLog, GBM_FAMILY } from '../market/models/gbmModel.js';
import { RIDGE_FAMILY } from '../market/models/ridgeModel.js';
import logger from '../logger.js';

/** In-process artifact cache, invalidated by the registry's created_at. */
const cache = {
  [RIDGE_FAMILY]: { createdAt: null, entry: null },
  [GBM_FAMILY]: { createdAt: null, entry: null, prepared: null },
};

function loadCachedModel(db, family) {
  const stamp = db.prepare(`SELECT created_at FROM homeserver_models WHERE family = ?`).get(family);
  if (!stamp) {
    cache[family] = { createdAt: null, entry: null, prepared: null };
    return null;
  }
  if (cache[family].createdAt !== stamp.created_at) {
    let entry = loadModel(db, family);
    let prepared = null;
    if (entry && family === GBM_FAMILY) {
      try {
        prepared = prepareGbmArtifact(entry.artifact);
      } catch (error) {
        logger.warn('stored gbm artifact is not evaluable; skipping gbm scores until next retrain', error);
        entry = null;
      }
    }
    cache[family] = { createdAt: stamp.created_at, entry, prepared };
  }
  return cache[family];
}

function geocodeAccuracy(db, address) {
  if (!address || !SqliteConnection.tableExists('homeserver_geocode_cache')) return null;
  const row = db
    .prepare(`SELECT accuracy FROM homeserver_geocode_cache WHERE address_key = ? AND status = 'ok'`)
    .get(addressKey(address));
  return row?.accuracy ?? null;
}

function findSurfaceCell(db, artifact, x, y) {
  if (!SqliteConnection.tableExists('homeserver_market_surface_cells')) return null;
  const cellSize = artifact.surfaceCellSizeM;
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
    const cellX = row.center_longitude * artifact.projection.metersPerLongitudeDegree;
    const cellY = row.center_latitude * artifact.projection.metersPerLatitudeDegree;
    const distance = Math.hypot(cellX - x, cellY - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = row;
    }
  }
  return best;
}

function withinTrainingBand(artifact, actualLog) {
  const band = artifact.trainingLogBand;
  if (!band) return true;
  return actualLog >= band.lo && actualLog <= band.hi;
}

function scoreRidge(db, entry, input) {
  const artifact = entry?.artifact;
  if (!artifact || !Array.isArray(artifact.beta) || !Array.isArray(artifact.means) || !Array.isArray(artifact.stds)) {
    return null;
  }
  const vector = hedonicDesignVector({ ...input.listingShape, monthOffset: 0 });
  if (vector.length !== artifact.beta.length) return null;
  if (!withinTrainingBand(artifact, input.actualLog)) return null;

  let hedonicLog = 0;
  for (let i = 0; i < vector.length; i += 1) {
    hedonicLog += artifact.beta[i] * ((vector[i] - artifact.means[i]) / artifact.stds[i]);
  }

  let residualLog = 0;
  let comps500m = 0;
  if (input.hasCoords) {
    const x = input.longitude * artifact.projection.metersPerLongitudeDegree;
    const y = input.latitude * artifact.projection.metersPerLatitudeDegree;
    const cell = findSurfaceCell(db, artifact, x, y);
    if (cell) {
      try {
        const components = JSON.parse(cell.surface_components_json);
        residualLog = components.residualLog ?? 0;
      } catch {
        residualLog = 0;
      }
      comps500m = cell.samples_500m ?? 0;
    }
  }

  const predLog = hedonicLog + residualLog + (artifact.logSmear ?? 0);
  const interval = conformalIntervalLog(artifact.conformal, input.tier, { predLog });
  const fairPricePerSqm = Math.max(1, Math.exp(predLog));
  return {
    family: RIDGE_FAMILY,
    version: artifact.version,
    modelCreatedAt: entry.createdAt,
    fairPricePerSqm,
    fairLoPricePerSqm: interval ? Math.exp(interval.loLog) : null,
    fairHiPricePerSqm: interval ? Math.exp(interval.hiLog) : null,
    coverageLevel: artifact.conformal?.level ?? null,
    deltaPercent: (100 * (input.actualPricePerSqm - fairPricePerSqm)) / fairPricePerSqm,
    comps500m,
  };
}

function scoreGbm(db, cached, input) {
  const artifact = cached?.entry?.artifact;
  if (!artifact || !cached.prepared) return null;
  const vector = gbmFeatureVector({ ...input.listingShape, ageDays: 0 });
  if (!Array.isArray(artifact.featureNames) || vector.length !== artifact.featureNames.length) return null;
  if (!withinTrainingBand(artifact, input.actualLog)) return null;

  const raw = predictGbmLog(cached.prepared, vector);
  const interval = conformalIntervalLog(artifact.conformal, input.tier, raw);
  const fairPricePerSqm = Math.max(1, Math.exp(raw.midLog));
  return {
    family: GBM_FAMILY,
    version: artifact.version,
    modelCreatedAt: cached.entry.createdAt,
    fairPricePerSqm,
    fairLoPricePerSqm: interval ? Math.exp(interval.loLog) : null,
    fairHiPricePerSqm: interval ? Math.exp(interval.hiLog) : null,
    coverageLevel: artifact.conformal?.level ?? null,
    deltaPercent: (100 * (input.actualPricePerSqm - fairPricePerSqm)) / fairPricePerSqm,
    comps500m: null,
  };
}

/**
 * Price one listing against both persisted models. Returns null when the
 * listing cannot be scored at all (missing price/size, no artifacts, both
 * models out of band).
 *
 * @param {object} listing
 * @param {object} [precomputedAttrs] structured attributes from the LLM extraction (with a
 *   `features` map) when the caller already has them.
 * @returns {{
 *   actualPricePerSqm: number, priceType: string, swap: boolean,
 *   coordQuality: string,
 *   models: {ridge: object|null, gbm: object|null},
 * }|null}
 */
export function scoreListingNow(listing, precomputedAttrs = null) {
  const db = SqliteConnection.getConnection();
  if (!SqliteConnection.tableExists('homeserver_models')) return null;

  const price = Number(listing.price);
  const size = Number(listing.size);
  if (!(price > 0) || !(size >= 10 && size <= 400)) return null;

  // Attributes come exclusively from the LLM extraction now; without them
  // the listing is scored on its headline price with unknown price type.
  const attrs = precomputedAttrs ?? { priceType: 'unknown', swap: false, features: null };
  const target = coldEquivalentRent(attrs, price);
  const scoredRent = target.rent ?? price;
  const actualPricePerSqm = scoredRent / size;
  if (!(actualPricePerSqm > 0)) return null;
  const actualLog = Math.log(actualPricePerSqm);

  const lat = Number(listing.latitude);
  const lng = Number(listing.longitude);
  const hasCoords = hasUsableCoordinates(listing.latitude, listing.longitude);
  const accuracy = geocodeAccuracy(db, listing.address);
  const tier = coordQualityTier(accuracy, hasCoords);

  const features = attrs.features ?? structuredFeatureFlags(attrs);
  const listingShape = {
    size,
    // From the listing row, like `size`, and not from the attributes. Both held
    // the same value written by the same line of the canonical builder, and the
    // duplicate is what let the attribute shadow the column when a notification
    // row spread one over the other.
    rooms: Number.isFinite(Number(listing.rooms)) ? Number(listing.rooms) : null,
    bedrooms: attrs.bedrooms,
    bathrooms: attrs.bathrooms,
    floor: attrs.floor,
    totalFloors: attrs.totalFloors,
    buildingYear: attrs.buildingYear,
    propertyType: attrs.propertyType,
    // Must match enrichRow's shape field for field. A value present at training
    // time and absent here is not a missing feature, it is a different model:
    // the vector still has the right length, so nothing errors, and every score
    // is quietly biased by whatever the trainer learned from a column that is
    // always empty at prediction time.
    condition: attrs.condition,
    energyClass: attrs.energyClass,
    priceType: target.type,
    features,
    latitude: hasCoords ? lat : null,
    longitude: hasCoords ? lng : null,
    geocodeQuality: accuracy,
  };
  const input = { listingShape, actualPricePerSqm, actualLog, hasCoords, latitude: lat, longitude: lng, tier };

  let ridge = null;
  let gbm = null;
  try {
    ridge = scoreRidge(db, loadCachedModel(db, RIDGE_FAMILY)?.entry ?? null, input);
  } catch (error) {
    logger.warn('ridge scoring failed for a listing; continuing without it', error);
  }
  try {
    gbm = scoreGbm(db, loadCachedModel(db, GBM_FAMILY), input);
  } catch (error) {
    logger.warn('gbm scoring failed for a listing; continuing without it', error);
  }
  if (!ridge && !gbm) return null;

  return {
    actualPricePerSqm,
    priceType: target.type,
    swap: Boolean(attrs.swap),
    coordQuality: tier,
    models: { ridge, gbm },
  };
}

const RENT_KIND_LABEL = { cold: 'cold', cold_est: '~cold', warm: 'warm', unknown: 'rent?' };

function formatModelSegment(label, model) {
  if (!model) return null;
  const sign = (value) => (value >= 0 ? `+${value.toFixed(1)}` : value.toFixed(1));
  const band =
    model.fairLoPricePerSqm != null && model.fairHiPricePerSqm != null
      ? ` [${model.fairLoPricePerSqm.toFixed(1)}–${model.fairHiPricePerSqm.toFixed(1)}]`
      : '';
  const comps = model.comps500m != null && model.comps500m > 0 ? ` (${model.comps500m}≤500m)` : '';
  return `${label} fair ${model.fairPricePerSqm.toFixed(2)}${band} ${sign(model.deltaPercent)}%${comps}`;
}

/**
 * Human-readable one-line summary of both model scores for notifications.
 * Interval brackets are the conformal fair-price band (coverage per the
 * artifact's level, default 80%).
 *
 * @param {object} score scoreListingNow output
 * @returns {string}
 */
export function formatScoreLine(score) {
  const segments = [
    `Ask ${score.actualPricePerSqm.toFixed(2)} €/m² (${RENT_KIND_LABEL[score.priceType] ?? 'rent?'})`,
    formatModelSegment('ridge', score.models?.ridge),
    formatModelSegment('gbm', score.models?.gbm),
  ].filter(Boolean);
  if (score.swap) segments.push('SWAP LISTING');
  return segments.join(' · ');
}
