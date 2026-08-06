/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { addressKey } from '../geocoding/address.js';
import { hedonicDesignVector, structuredFeatureFlags, gbmFeatureVector, clamp } from './hedonicFeatures.js';
import { coldRent } from '../market/corpus.js';
import {
  conformalIntervalLog,
  coordQualityTier,
  geocodePenaltyFor,
  EMPTY_FIELD_CONFIDENCE,
} from '../market/conformal.js';
import { loadModel } from '../market/modelRegistry.js';
import { hasUsableCoordinates } from '../market/geo.js';
import { prepareGbmArtifact, predictGbmLog, GBM_FAMILY } from '../market/models/gbmModel.js';
import { RIDGE_FAMILY } from '../market/models/ridgeModel.js';
import { emptyFieldResult, fieldAt, hydrateField } from '../market/models/ridgeField.js';
import logger from '../logger.js';

const cache = {
  [RIDGE_FAMILY]: { createdAt: null, entry: null, prepared: null },
  [GBM_FAMILY]: { createdAt: null, entry: null, prepared: null },
};

// `prepared` is the per-family evaluable form of the stored artifact: the
// hydrated kernel field for ridge, the decoded tree ensemble for gbm. Both are
// rebuilt once per retrain rather than per listing.
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
    if (entry && family === RIDGE_FAMILY) {
      prepared = hydrateField(entry.artifact?.field);
      if (!prepared) {
        logger.warn('stored ridge artifact carries no field; skipping ridge scores until next retrain');
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

function withinTrainingBand(artifact, actualLog) {
  const band = artifact.trainingLogBand;
  if (!band) return true;
  return actualLog >= band.lo && actualLog <= band.hi;
}

function scoreRidge(cached, input) {
  const artifact = cached?.entry?.artifact;
  const field = cached?.prepared;
  if (!artifact || !field) return null;
  if (!Array.isArray(artifact.beta) || !Array.isArray(artifact.means) || !Array.isArray(artifact.stds)) {
    return null;
  }
  const vector = hedonicDesignVector(input.listingShape);
  if (vector.length !== artifact.beta.length) return null;
  if (!withinTrainingBand(artifact, input.actualLog)) return null;

  let hedonicLog = 0;
  for (let i = 0; i < vector.length; i += 1) {
    hedonicLog += artifact.beta[i] * ((vector[i] - artifact.means[i]) / artifact.stds[i]);
  }

  // Same estimator the run was evaluated with, over the field the run shipped.
  const surface = input.hasCoords
    ? fieldAt(
        input.longitude * artifact.projection.metersPerLongitudeDegree,
        input.latitude * artifact.projection.metersPerLatitudeDegree,
        field,
      )
    : emptyFieldResult(field);

  const predLog = hedonicLog + surface.residualLog + (artifact.logSmear ?? 0);
  const interval = conformalIntervalLog(artifact.conformal, input.tier, { predLog });
  const fairPricePerSqm = Math.max(1, Math.exp(predLog));
  const geocodePenalty = geocodePenaltyFor(input.tier);
  return {
    family: RIDGE_FAMILY,
    version: artifact.version,
    modelCreatedAt: cached.entry.createdAt,
    fairPricePerSqm,
    fairLoPricePerSqm: interval ? Math.exp(interval.loLog) : null,
    fairHiPricePerSqm: interval ? Math.exp(interval.hiLog) : null,
    coverageLevel: artifact.conformal?.level ?? null,
    deltaPercent: (100 * (input.actualPricePerSqm - fairPricePerSqm)) / fairPricePerSqm,
    comps500m: surface.samples500m,
    confidence: clamp(surface.confidence * geocodePenalty, EMPTY_FIELD_CONFIDENCE, 1),
    zScore: surface.spreadLog > 0 ? (predLog - input.actualLog) / surface.spreadLog : null,
  };
}

function scoreGbm(cached, input) {
  const artifact = cached?.entry?.artifact;
  if (!artifact || !cached.prepared) return null;
  const vector = gbmFeatureVector(input.listingShape);
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
    // The gbm family has no local field, so it has no local dispersion to
    // measure against. Consumers must treat a null confidence as "unknown"
    // rather than "fine".
    confidence: null,
    zScore: null,
  };
}

export function scoreListingNow(listing, precomputedAttrs = null) {
  const db = SqliteConnection.getConnection();
  if (!SqliteConnection.tableExists('homeserver_models')) return null;

  const price = Number(listing.price);
  const size = Number(listing.size);
  if (!(price > 0) || !(size >= 10 && size <= 400)) return null;

  const attrs = precomputedAttrs ?? { priceType: 'unknown', swap: false, features: null };
  const rent = coldRent(attrs, price);
  if (rent == null) return null;
  const actualPricePerSqm = rent / size;
  if (!(actualPricePerSqm > 0)) return null;
  const actualLog = Math.log(actualPricePerSqm);

  const lat = Number(listing.latitude);
  const lng = Number(listing.longitude);
  const hasCoords = hasUsableCoordinates(listing.latitude, listing.longitude);
  const accuracy = geocodeAccuracy(db, listing.address);
  const tier = coordQualityTier(accuracy, hasCoords);

  const features = structuredFeatureFlags(attrs, listing.full_text);
  const listingShape = {
    size,
    rooms: Number.isFinite(Number(listing.rooms)) ? Number(listing.rooms) : null,
    bedrooms: attrs.bedrooms,
    bathrooms: attrs.bathrooms,
    floor: attrs.floor,
    totalFloors: attrs.totalFloors,
    buildingYear: attrs.buildingYear,
    propertyType: attrs.propertyType,
    condition: attrs.condition,
    energyClass: attrs.energyClass,
    features,
    latitude: hasCoords ? lat : null,
    longitude: hasCoords ? lng : null,
    geocodeQuality: accuracy,
  };
  const input = { listingShape, actualPricePerSqm, actualLog, hasCoords, latitude: lat, longitude: lng, tier };

  let ridge = null;
  let gbm = null;
  try {
    ridge = scoreRidge(loadCachedModel(db, RIDGE_FAMILY), input);
  } catch (error) {
    logger.warn('ridge scoring failed for a listing; continuing without it', error);
  }
  try {
    gbm = scoreGbm(loadCachedModel(db, GBM_FAMILY), input);
  } catch (error) {
    logger.warn('gbm scoring failed for a listing; continuing without it', error);
  }
  if (!ridge && !gbm) return null;

  return {
    actualPricePerSqm,
    swap: Boolean(attrs.swap),
    coordQuality: tier,
    models: { ridge, gbm },
  };
}

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

export function formatScoreLine(score) {
  const segments = [
    `Ask ${score.actualPricePerSqm.toFixed(2)} €/m² kalt`,
    formatModelSegment('ridge', score.models?.ridge),
    formatModelSegment('gbm', score.models?.gbm),
  ].filter(Boolean);
  if (score.swap) segments.push('SWAP LISTING');
  return segments.join(' · ');
}
