/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Ridge market model, v4 ("ridge" family).
 *
 * Two-stage regression kriging on log cold-€/m²:
 * 1. a robust (Huber-IRLS to convergence) ridge regression on the
 *    STANDARDIZED hedonic design matrix — λ and the recency half-life are
 *    selected by spatially-blocked cross-validation, not hardcoded;
 * 2. an adaptive-bandwidth Gaussian kernel field over the residuals, with
 *    bandwidth clamps derived from the data's own neighbour-distance
 *    distribution and same-cluster exclusion so a flat is never predicted
 *    from copies of itself.
 *
 * Point predictions carry a Duan smearing correction (folded into the
 * prediction as log-smear so intervals and point estimates share one
 * center). Intervals are Mondrian split-conformal, calibrated on
 * out-of-fold predictions from folds that are salted differently from the
 * hyper-parameter search folds.
 *
 * The solver is a Cholesky decomposition — the ridge penalty makes the
 * normal equations positive definite, so unlike the previous Gauss-Jordan
 * there is no silent zeroing of collinear coefficients.
 */

import { hedonicDesignVector, hedonicTermNames, dot, clamp } from '../../scoring/hedonicFeatures.js';
import { weightFor, SURFACE_CELL_M } from '../corpus.js';
import { gridKey } from '../geo.js';
import { median, quantile, weightedQuantile, effectiveSampleSize, gaussianWeight, roundMetric } from '../stats.js';
import { assignFolds, buildEvalReport } from '../evaluation.js';
import { calibrateConformal, conformalIntervalLog } from '../conformal.js';

export const RIDGE_VERSION = 'ridge-v4';
export const RIDGE_FAMILY = 'ridge';

const LAMBDA_GRID = [0.03, 0.1, 0.3, 1, 3, 10, 30];
const HALF_LIFE_GRID_DAYS = [45, 90, 180, 365];
const IRLS_MAX_ITERATIONS = 50;
const IRLS_TOLERANCE = 1e-8;
const HUBER_K = 1.345;
const KERNEL_NEIGHBORS = 8;
const INDEX_CELL_M = 250;
const MIN_LOG_SPREAD = 0.05;
const MIN_TRAINING_ROWS = 40;
const TRUSTED_TIER = 'trusted';

/**
 * Train the ridge model: hyper-parameter search, conformal calibration,
 * final fit, artifact assembly.
 *
 * @param {object} options
 * @param {object[]} options.trainingRows corpus training rows
 * @param {object} options.projection buildProjection output
 * @param {number} options.now epoch ms
 * @param {number} options.level target conformal coverage (e.g. 0.8)
 * @returns {{artifact: object, model: object, evaluation: object}|null}
 *   null when the corpus is too small to fit anything trustworthy.
 */
export function trainRidgeModel({ trainingRows, projection, now, level }) {
  if (trainingRows.length < MIN_TRAINING_ROWS) return null;

  const bandwidthClamps = deriveBandwidthClamps(trainingRows);

  // Hyper-parameter search on its own fold layout.
  const searchFolds = assignFolds(trainingRows, { salt: 'ridge-params' });
  let best = null;
  for (const halfLifeDays of HALF_LIFE_GRID_DAYS) {
    for (const lambda of LAMBDA_GRID) {
      const oof = crossValidate(trainingRows, searchFolds, { lambda, halfLifeDays, bandwidthClamps });
      const mdape = median(
        oof.map((row) => Math.abs(Math.exp(row.predLog) - row.actual) / row.actual).filter(Number.isFinite),
      );
      if (mdape == null) continue;
      // Ties break toward the stronger penalty: same error, more stability.
      if (!best || mdape < best.mdape - 1e-9 || (Math.abs(mdape - best.mdape) <= 1e-9 && lambda > best.lambda)) {
        best = { lambda, halfLifeDays, mdape };
      }
    }
  }
  if (!best) return null;

  // Calibration + evaluation on independently salted folds.
  const calibrationFolds = assignFolds(trainingRows, { salt: 'ridge-calibration' });
  const oof = crossValidate(trainingRows, calibrationFolds, { ...best, bandwidthClamps });
  const conformalRows = oof.map((row) => ({ tier: row.tier, yLog: row.yLog, predLog: row.predLog }));
  const evaluation = {
    ...buildEvalReport({
      pairs: oof.map((row) => ({ actual: row.actual, predicted: Math.exp(row.predLog) })),
      conformalRows,
      mode: 'residual',
      level,
      trainingRows,
    }),
    lambda: best.lambda,
    halfLifeDays: best.halfLifeDays,
  };
  const conformal = calibrateConformal({ mode: 'residual', level, rows: conformalRows });

  // Final fit on everything.
  const hedonic = fitHedonic(trainingRows, best);
  const field = buildField(trainingRows, hedonic, best.halfLifeDays, bandwidthClamps);
  const logSmear = computeLogSmear(trainingRows, hedonic, field);

  const logValues = trainingRows.map((row) => row.logPricePerSqm);
  const artifact = {
    version: RIDGE_VERSION,
    family: RIDGE_FAMILY,
    trainedAt: now,
    trainingRows: trainingRows.length,
    lambda: best.lambda,
    halfLifeDays: best.halfLifeDays,
    level,
    featureNames: hedonicTermNames(),
    means: hedonic.means,
    stds: hedonic.stds,
    beta: hedonic.beta,
    logSmear,
    baselineLog: hedonic.beta[0] + logSmear,
    conformal,
    projection: {
      referenceLatitude: projection.referenceLatitude,
      metersPerLatitudeDegree: projection.metersPerLatitudeDegree,
      metersPerLongitudeDegree: projection.metersPerLongitudeDegree,
    },
    surfaceCellSizeM: SURFACE_CELL_M,
    // Scorer sanity band, derived from the trimmed corpus itself.
    trainingLogBand: {
      lo: Math.min(...logValues) - 0.5,
      hi: Math.max(...logValues) + 0.5,
    },
  };

  const model = {
    artifact,
    hedonic,
    field,
    logSmear,
    conformal,
    level,
    /**
     * Full-pipeline log prediction (hedonic + field + smear) for a corpus row.
     * @param {object} row
     * @param {{atOwnTime?: boolean}} [options]
     */
    predictRow(row, options = {}) {
      const surface = row.hasCoords ? fieldAt(row.x, row.y, field, row.clusterId) : emptyFieldResult(field);
      const hedonicLog = hedonic.predictLog(row, { atOwnTime: options.atOwnTime === true });
      return { predLog: hedonicLog + surface.residualLog + logSmear, surface };
    },
    scoreCorpusRow(row) {
      return scoreCorpusRow(row, model);
    },
  };

  return { artifact, model, evaluation };
}

/* ------------------------------ hedonic fit ------------------------------ */

function fitHedonic(rows, { lambda, halfLifeDays }) {
  const raw = rows.map((row) => hedonicDesignVector(row));
  const y = rows.map((row) => row.logPricePerSqm);
  const recency = rows.map((row) => weightFor(row.ageDays, halfLifeDays));
  const { means, stds, standardized } = standardizeColumns(raw);
  const dimensions = means.length;

  let beta = new Array(dimensions).fill(0);
  beta[0] = weightedQuantile(
    y.map((value, index) => ({ value, weight: recency[index] })),
    0.5,
  );

  for (let iteration = 0; iteration < IRLS_MAX_ITERATIONS; iteration += 1) {
    const residuals = standardized.map((z, index) => y[index] - dot(z, beta));
    const scale = Math.max(1.4826 * (median(residuals.map(Math.abs)) ?? 0.1), 1e-3);
    const weights = residuals.map(
      (residual, index) => recency[index] * Math.min(1, (HUBER_K * scale) / Math.max(Math.abs(residual), 1e-9)),
    );
    const updated = solveWeightedRidge(standardized, y, weights, lambda);
    const maxDelta = Math.max(...updated.map((value, index) => Math.abs(value - beta[index])));
    beta = updated;
    if (maxDelta < IRLS_TOLERANCE) break;
  }

  const predictLog = (row, { atOwnTime = false } = {}) => {
    const vector = hedonicDesignVector(atOwnTime ? row : { ...row, monthOffset: 0 });
    let sum = 0;
    for (let i = 0; i < vector.length; i += 1) {
      sum += beta[i] * ((vector[i] - means[i]) / stds[i]);
    }
    return sum;
  };

  return { beta, means, stds, predictLog };
}

function standardizeColumns(matrix) {
  const dimensions = matrix[0].length;
  const means = new Array(dimensions).fill(0);
  const stds = new Array(dimensions).fill(1);
  for (let j = 1; j < dimensions; j += 1) {
    let sum = 0;
    for (const row of matrix) sum += row[j];
    const mean = sum / matrix.length;
    let variance = 0;
    for (const row of matrix) variance += (row[j] - mean) ** 2;
    const std = Math.sqrt(variance / Math.max(1, matrix.length - 1));
    means[j] = mean;
    stds[j] = Number.isFinite(std) && std > 1e-12 ? std : 1;
  }
  const standardized = matrix.map((row) => row.map((value, j) => (value - means[j]) / stds[j]));
  return { means, stds, standardized };
}

function solveWeightedRidge(standardized, y, weights, lambda) {
  const dimensions = standardized[0].length;
  const xtwx = Array.from({ length: dimensions }, () => new Array(dimensions).fill(0));
  const xtwy = new Array(dimensions).fill(0);
  standardized.forEach((row, index) => {
    const w = weights[index];
    for (let i = 0; i < dimensions; i += 1) {
      xtwy[i] += w * row[i] * y[index];
      for (let j = i; j < dimensions; j += 1) {
        xtwx[i][j] += w * row[i] * row[j];
      }
    }
  });
  for (let i = 0; i < dimensions; i += 1) {
    for (let j = 0; j < i; j += 1) xtwx[i][j] = xtwx[j][i];
    // Standardized columns share one scale, so a single λ is meaningful.
    // The intercept stays (almost) unpenalized.
    xtwx[i][i] += i > 0 ? lambda : 1e-9;
  }
  return choleskySolve(xtwx, xtwy);
}

/**
 * Solve A x = b for symmetric positive-definite A via Cholesky. The ridge
 * penalty guarantees positive definiteness; a tiny diagonal jitter retry
 * covers pathological numerics. Throws when the system is genuinely
 * unsolvable — silent coefficient zeroing is exactly what v3 did wrong.
 *
 * @param {number[][]} a
 * @param {number[]} b
 * @returns {number[]}
 */
export function choleskySolve(a, b) {
  const n = b.length;
  const attempt = (jitter) => {
    const l = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j <= i; j += 1) {
        let sum = a[i][j] + (i === j ? jitter : 0);
        for (let k = 0; k < j; k += 1) sum -= l[i][k] * l[j][k];
        if (i === j) {
          if (sum <= 0) return null;
          l[i][j] = Math.sqrt(sum);
        } else {
          l[i][j] = sum / l[j][j];
        }
      }
    }
    const forward = new Array(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      let sum = b[i];
      for (let k = 0; k < i; k += 1) sum -= l[i][k] * forward[k];
      forward[i] = sum / l[i][i];
    }
    const solution = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i -= 1) {
      let sum = forward[i];
      for (let k = i + 1; k < n; k += 1) sum -= l[k][i] * solution[k];
      solution[i] = sum / l[i][i];
    }
    return solution;
  };
  const direct = attempt(0);
  if (direct) return direct;
  const trace = a.reduce((sum, row, index) => sum + row[index], 0);
  const jittered = attempt(Math.max(1e-8, (1e-8 * trace) / n));
  if (jittered) return jittered;
  throw new Error('ridge normal equations are not positive definite');
}

/* ----------------------------- residual field ---------------------------- */

function deriveBandwidthClamps(rows) {
  const observations = rows.filter((row) => row.hasCoords);
  if (observations.length < KERNEL_NEIGHBORS + 1) {
    return { minBandwidthM: 150, maxBandwidthM: 1200 };
  }
  const index = new Map();
  for (const row of observations) {
    const key = gridKey(row.x, row.y, INDEX_CELL_M);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }
  const knnDistances = [];
  for (const row of observations) {
    const distance = kthNeighborDistance(row, index, KERNEL_NEIGHBORS);
    if (Number.isFinite(distance)) knnDistances.push(distance);
  }
  const minBandwidthM = Math.max(25, quantile(knnDistances, 0.05) ?? 150);
  const maxBandwidthM = Math.max(minBandwidthM * 2, quantile(knnDistances, 0.95) ?? 1200);
  return { minBandwidthM, maxBandwidthM };
}

function kthNeighborDistance(row, index, k) {
  for (let radiusM = INDEX_CELL_M * 2; radiusM <= INDEX_CELL_M * 64; radiusM *= 2) {
    const distances = [];
    forEachCandidate(row.x, row.y, index, radiusM, (candidate) => {
      if (candidate.id !== row.id) distances.push(Math.hypot(candidate.x - row.x, candidate.y - row.y));
    });
    if (distances.length >= k) {
      distances.sort((a, b) => a - b);
      return distances[k - 1];
    }
  }
  return Number.POSITIVE_INFINITY;
}

function buildField(rows, hedonic, halfLifeDays, clamps) {
  const observations = rows
    .filter((row) => row.hasCoords)
    .map((row) => ({
      id: row.id,
      clusterId: row.clusterId,
      x: row.x,
      y: row.y,
      weight: weightFor(row.ageDays, halfLifeDays),
      residualLog: row.logPricePerSqm - hedonic.predictLog(row, { atOwnTime: true }),
    }));
  const index = new Map();
  for (const observation of observations) {
    const key = gridKey(observation.x, observation.y, INDEX_CELL_M);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(observation);
  }
  const globalSpreadLog = Math.max(
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
  return { index, clamps, globalSpreadLog, searchRadiusM: 3 * clamps.maxBandwidthM };
}

function emptyFieldResult(field) {
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

/**
 * Kernel-weighted local residual at a point, excluding same-cluster rows.
 *
 * @param {number} x
 * @param {number} y
 * @param {object} field buildField output
 * @param {string|null} excludedClusterId
 * @returns {object}
 */
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
      weight: candidate.weight * gaussianWeight(candidate.distanceM, bandwidthM),
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

function forEachCandidate(x, y, index, radiusM, visit) {
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

/* --------------------------- cross-validation ---------------------------- */

function crossValidate(rows, folds, { lambda, halfLifeDays, bandwidthClamps }) {
  const foldCount = Math.max(...folds) + 1;
  const results = [];
  for (let fold = 0; fold < foldCount; fold += 1) {
    const trainSubset = rows.filter((_, index) => folds[index] !== fold);
    const testSubset = rows.filter((_, index) => folds[index] === fold);
    if (!trainSubset.length || !testSubset.length) continue;
    const hedonic = fitHedonic(trainSubset, { lambda, halfLifeDays });
    const field = buildField(trainSubset, hedonic, halfLifeDays, bandwidthClamps);
    const logSmear = computeLogSmear(trainSubset, hedonic, field);
    for (const row of testSubset) {
      const surface = row.hasCoords ? fieldAt(row.x, row.y, field, row.clusterId) : emptyFieldResult(field);
      // Predict at the row's own time so the error measures the model, not
      // the drift between train and test windows.
      const predLog = hedonic.predictLog(row, { atOwnTime: true }) + surface.residualLog + logSmear;
      results.push({ tier: row.tier, yLog: row.logPricePerSqm, predLog, actual: row.pricePerSqm });
    }
  }
  return results;
}

function computeLogSmear(rows, hedonic, field) {
  const factors = [];
  const weights = [];
  for (const row of rows) {
    const surface = row.hasCoords ? fieldAt(row.x, row.y, field, row.clusterId) : emptyFieldResult(field);
    const residual = row.logPricePerSqm - (hedonic.predictLog(row, { atOwnTime: true }) + surface.residualLog);
    if (!Number.isFinite(residual)) continue;
    factors.push(Math.exp(residual));
    weights.push(1);
  }
  if (!factors.length) return 0;
  const smear = factors.reduce((sum, value) => sum + value, 0) / weights.length;
  // Cap the correction: a smear far from 1 means the residuals are not
  // roughly symmetric in log space and the correction itself is suspect.
  return Math.log(clamp(smear, 0.8, 1.25));
}

/* ------------------------------ batch scores ------------------------------ */

function scoreCorpusRow(row, model) {
  const surface = row.hasCoords ? fieldAt(row.x, row.y, model.field, row.clusterId) : emptyFieldResult(model.field);
  const predLog = model.hedonic.predictLog(row, { atOwnTime: false }) + surface.residualLog + model.logSmear;
  const prediction = Math.max(1, Math.exp(predLog));
  const actual = row.pricePerSqm;
  const residual = actual - prediction;
  const interval = conformalIntervalLog(model.conformal, row.tier, { predLog });
  const geocodePenalty = row.tier === TRUSTED_TIER ? 1 : 0.75;
  const confidence = clamp(surface.confidence * geocodePenalty, 0.05, 1);

  const ownResidualLog =
    row.logPricePerSqm != null
      ? row.logPricePerSqm - (model.hedonic.predictLog(row, { atOwnTime: true }) + model.logSmear)
      : Math.log(actual) - (model.hedonic.predictLog(row, { atOwnTime: true }) + model.logSmear);
  const zScore = (predLog - Math.log(actual)) / surface.spreadLog;

  let percentile = null;
  if (surface.points.length >= 4) {
    const totalWeight = surface.points.reduce((sum, point) => sum + point.weight, 0);
    if (totalWeight > 0) {
      const below = surface.points.reduce((sum, point) => sum + (point.value < ownResidualLog ? point.weight : 0), 0);
      percentile = (100 * below) / totalWeight;
    }
  }

  return {
    listingId: row.id,
    createdAt: row.createdAt,
    provider: row.provider,
    link: row.link,
    title: row.title,
    isHidden: row.isHidden ? 1 : 0,
    actualPriceEur: roundMetric(row.price),
    targetRentEur: roundMetric(row.targetRent),
    priceType: row.priceType,
    sizeSqm: roundMetric(row.size),
    rooms: row.rooms,
    actualPricePerSqm: roundMetric(actual),
    predictedPricePerSqm: roundMetric(prediction),
    predictedLoPricePerSqm: interval ? roundMetric(Math.exp(interval.loLog)) : null,
    predictedHiPricePerSqm: interval ? roundMetric(Math.exp(interval.hiLog)) : null,
    residualPricePerSqm: roundMetric(residual),
    deltaPercent: roundMetric((100 * residual) / prediction),
    zScore: roundMetric(zScore),
    percentile: roundMetric(percentile),
    confidence: roundMetric(confidence),
    nearbyComps250m: surface.samples250m,
    nearbyComps500m: surface.samples500m,
    nearbyComps1000m: surface.samples1000m,
    geoCell: row.geoCell,
    area: row.area,
    sizeBand: row.sizeBand,
    roomsBand: row.roomsBand,
    featureFlagsJson: JSON.stringify(row.features),
    geocodeQuality: row.geocodeQuality,
  };
}

/**
 * Build the 125m surface cells around the training data from a trained
 * model (fair €/m² per cell for the map layer and the notification-time
 * scorer's residual lookup).
 *
 * @param {object} model trainRidgeModel output .model
 * @param {object[]} trainingRows
 * @param {object} projection
 * @param {number} minConfidence cells below this are not persisted
 * @returns {object[]}
 */
export function buildSurfaceCells(model, trainingRows, projection, minConfidence) {
  const margin = 2;
  const cellKeys = new Set();
  for (const row of trainingRows) {
    if (!row.hasCoords) continue;
    const cellX = Math.floor(row.x / SURFACE_CELL_M);
    const cellY = Math.floor(row.y / SURFACE_CELL_M);
    for (let x = cellX - margin; x <= cellX + margin; x += 1) {
      for (let y = cellY - margin; y <= cellY + margin; y += 1) {
        cellKeys.add(`${x}:${y}`);
      }
    }
  }

  const rows = [];
  for (const key of cellKeys) {
    const [cellX, cellY] = key.split(':').map(Number);
    const x = (cellX + 0.5) * SURFACE_CELL_M;
    const y = (cellY + 0.5) * SURFACE_CELL_M;
    const surface = fieldAt(x, y, model.field);
    if (surface.confidence < minConfidence) continue;
    const center = projection.unproject(x, y);
    rows.push({
      cellId: `${SURFACE_CELL_M}m:${key}`,
      cellSizeM: SURFACE_CELL_M,
      centerLatitude: roundMetric(center.latitude),
      centerLongitude: roundMetric(center.longitude),
      predictedPricePerSqm: roundMetric(Math.exp(model.artifact.baselineLog + surface.residualLog)),
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
