/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { clamp } from '../../scoring/hedonicFeatures.js';
import { gridKey } from '../geo.js';
import { quantile, weightedQuantile, effectiveSampleSize, gaussianWeight } from '../stats.js';

export const KERNEL_NEIGHBORS = 8;
export const INDEX_CELL_M = 250;

const MIN_LOG_SPREAD = 0.05;

// The local price surface: kernel regression over the hedonic residuals of
// nearby training rows. Training and serving both evaluate through `fieldAt`,
// because a model whose reported error came from a different estimator than the
// one answering live listings is reporting someone else's accuracy.
export function buildField(rows, hedonic, clamps) {
  const observations = rows
    .filter((row) => row.hasCoords)
    .map((row) => ({
      id: row.id,
      clusterId: row.clusterId,
      x: row.x,
      y: row.y,
      residualLog: row.logPricePerSqm - hedonic.predictLog(row),
    }));
  return fieldFrom(observations, clamps);
}

function fieldFrom(observations, clamps, globalSpreadLog = null) {
  const index = new Map();
  for (const observation of observations) {
    const key = gridKey(observation.x, observation.y, INDEX_CELL_M);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(observation);
  }
  const spread =
    globalSpreadLog ??
    Math.max(
      MIN_LOG_SPREAD,
      (quantile(
        observations.map((o) => o.residualLog),
        0.75,
      ) ?? 0) -
        (quantile(
          observations.map((o) => o.residualLog),
          0.25,
        ) ?? 0),
    );
  return { index, clamps, globalSpreadLog: spread, searchRadiusM: 3 * clamps.maxBandwidthM };
}

// Serialized into the model artifact so serving rebuilds the same field the run
// was scored against. clusterId is deliberately omitted: it exists only for
// leave-one-cluster-out exclusion while training, and a listing being scored
// live has no own-cluster to withhold.
export function serializeField(field) {
  const observations = [];
  for (const bucket of field.index.values()) {
    for (const observation of bucket) {
      observations.push([round(observation.x, 1), round(observation.y, 1), round(observation.residualLog, 6)]);
    }
  }
  return { observations, clamps: field.clamps, globalSpreadLog: round(field.globalSpreadLog, 6) };
}

export function hydrateField(serialized) {
  if (!serialized || !Array.isArray(serialized.observations) || !serialized.clamps) return null;
  const observations = serialized.observations.map(([x, y, residualLog]) => ({
    id: null,
    clusterId: null,
    x,
    y,
    residualLog,
  }));
  return fieldFrom(observations, serialized.clamps, serialized.globalSpreadLog);
}

export function emptyFieldResult(field) {
  return {
    residualLog: 0,
    confidence: 0.05,
    bandwidthM: field.clamps.maxBandwidthM,
    spreadLog: field.globalSpreadLog,
    effectiveSamples: 0,
    samples250m: 0,
    samples500m: 0,
    samples1000m: 0,
    points: [],
  };
}

export function fieldAt(x, y, field, excludedClusterId = null) {
  const candidates = [];
  forEachCandidate(x, y, field.index, field.searchRadiusM, (observation) => {
    if (excludedClusterId != null && observation.clusterId === excludedClusterId) return;
    const distanceM = Math.hypot(observation.x - x, observation.y - y);
    if (distanceM <= field.searchRadiusM) candidates.push({ ...observation, distanceM });
  });
  const samples250m = candidates.filter((candidate) => candidate.distanceM <= 250).length;
  const samples500m = candidates.filter((candidate) => candidate.distanceM <= 500).length;
  const samples1000m = candidates.filter((candidate) => candidate.distanceM <= 1000).length;
  if (!candidates.length) return { ...emptyFieldResult(field), samples250m, samples500m, samples1000m };

  candidates.sort((a, b) => a.distanceM - b.distanceM);
  const knnDistance = candidates[Math.min(KERNEL_NEIGHBORS, candidates.length) - 1].distanceM;
  const bandwidthM = clamp(knnDistance, field.clamps.minBandwidthM, field.clamps.maxBandwidthM);
  const points = candidates
    .filter((candidate) => candidate.distanceM <= 3 * bandwidthM)
    .map((candidate) => ({
      value: candidate.residualLog,
      weight: gaussianWeight(candidate.distanceM, bandwidthM),
    }));
  const residualLog = weightedQuantile(points, 0.5);
  if (residualLog == null) return { ...emptyFieldResult(field), samples250m, samples500m, samples1000m };

  const effectiveSamples = effectiveSampleSize(points);
  const spreadLog = Math.max(
    MIN_LOG_SPREAD,
    (weightedQuantile(points, 0.75) ?? 0) - (weightedQuantile(points, 0.25) ?? 0),
  );
  const confidence = clamp(
    Math.min(1, effectiveSamples / 12) * Math.sqrt(field.clamps.minBandwidthM / bandwidthM),
    0.05,
    1,
  );

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

export function forEachCandidate(x, y, index, radiusM, visit) {
  const radiusCells = Math.ceil(radiusM / INDEX_CELL_M);
  const baseCellX = Math.floor(x / INDEX_CELL_M);
  const baseCellY = Math.floor(y / INDEX_CELL_M);
  for (let cellX = baseCellX - radiusCells; cellX <= baseCellX + radiusCells; cellX += 1) {
    for (let cellY = baseCellY - radiusCells; cellY <= baseCellY + radiusCells; cellY += 1) {
      for (const observation of index.get(`${cellX}:${cellY}`) || []) {
        visit(observation);
      }
    }
  }
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}
