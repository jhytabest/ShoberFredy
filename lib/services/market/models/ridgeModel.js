/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { hedonicDesignVector, hedonicTermNames, dot, clamp } from '../../scoring/hedonicFeatures.js';
import { gridKey } from '../geo.js';
import { median, quantile, roundMetric } from '../stats.js';
import { assignFolds, buildEvalReport } from '../evaluation.js';
import { calibrateConformal, conformalIntervalLog, geocodePenaltyFor, EMPTY_FIELD_CONFIDENCE } from '../conformal.js';
import {
  buildField,
  emptyFieldResult,
  fieldAt,
  forEachCandidate,
  serializeField,
  INDEX_CELL_M,
  KERNEL_NEIGHBORS,
} from './ridgeField.js';

// v9: the field is serialized into the artifact so serving evaluates the same
// estimator the run was scored against. v8 artifacts have no field and are not
// loadable; the next scheduled retrain replaces them.
export const RIDGE_VERSION = 'ridge-v9';
export const RIDGE_FAMILY = 'ridge';

const LAMBDA_GRID = [0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000];
const IRLS_MAX_ITERATIONS = 50;
const IRLS_TOLERANCE = 1e-8;
const HUBER_K = 1.345;
const MIN_TRAINING_ROWS = 40;

export function trainRidgeModel({ trainingRows, projection, now, level }) {
  if (trainingRows.length < MIN_TRAINING_ROWS) return null;

  const bandwidthClamps = deriveBandwidthClamps(trainingRows);

  const searchFolds = assignFolds(trainingRows, { salt: 'ridge-params' });
  let best = null;
  for (const lambda of LAMBDA_GRID) {
    const oof = crossValidate(trainingRows, searchFolds, { lambda, bandwidthClamps });
    const mdape = median(
      oof.map((row) => Math.abs(Math.exp(row.predLog) - row.actual) / row.actual).filter(Number.isFinite),
    );
    if (mdape == null) continue;
    if (!best || mdape < best.mdape - 1e-9 || (Math.abs(mdape - best.mdape) <= 1e-9 && lambda > best.lambda)) {
      best = { lambda, mdape };
    }
  }
  if (!best) return null;

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
    lambdaAtBoundary: best.lambda === LAMBDA_GRID[LAMBDA_GRID.length - 1],
  };
  const conformal = calibrateConformal({ mode: 'residual', level, rows: conformalRows });

  const hedonic = fitHedonic(trainingRows, best);
  const field = buildField(trainingRows, hedonic, bandwidthClamps);
  const logSmear = computeLogSmear(trainingRows, hedonic, field);

  const logValues = trainingRows.map((row) => row.logPricePerSqm);
  const artifact = {
    version: RIDGE_VERSION,
    family: RIDGE_FAMILY,
    trainedAt: now,
    trainingRows: trainingRows.length,
    lambda: best.lambda,
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
    field: serializeField(field),
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
    predictRow(row) {
      const surface = row.hasCoords ? fieldAt(row.x, row.y, field, row.clusterId) : emptyFieldResult(field);
      return { predLog: hedonic.predictLog(row) + surface.residualLog + logSmear, surface };
    },
    scoreCorpusRow(row) {
      return scoreCorpusRow(row, model);
    },
  };

  return { artifact, model, evaluation };
}

function fitHedonic(rows, { lambda }) {
  const raw = rows.map((row) => hedonicDesignVector(row));
  const y = rows.map((row) => row.logPricePerSqm);
  const { means, stds, standardized } = standardizeColumns(raw);
  const dimensions = means.length;

  let beta = new Array(dimensions).fill(0);
  beta[0] = median(y) ?? 0;

  for (let iteration = 0; iteration < IRLS_MAX_ITERATIONS; iteration += 1) {
    const residuals = standardized.map((z, index) => y[index] - dot(z, beta));
    const scale = Math.max(1.4826 * (median(residuals.map(Math.abs)) ?? 0.1), 1e-3);
    const weights = residuals.map((residual) => Math.min(1, (HUBER_K * scale) / Math.max(Math.abs(residual), 1e-9)));
    const updated = solveWeightedRidge(standardized, y, weights, lambda);
    const maxDelta = Math.max(...updated.map((value, index) => Math.abs(value - beta[index])));
    beta = updated;
    if (maxDelta < IRLS_TOLERANCE) break;
  }

  const predictLog = (row) => {
    const vector = hedonicDesignVector(row);
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
    xtwx[i][i] += i > 0 ? lambda : 1e-9;
  }
  return choleskySolve(xtwx, xtwy);
}

function choleskySolve(a, b) {
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
  const medianBandwidthM = Math.min(maxBandwidthM, Math.max(minBandwidthM, quantile(knnDistances, 0.5) ?? 500));
  return { minBandwidthM, maxBandwidthM, medianBandwidthM };
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

function crossValidate(rows, folds, { lambda, bandwidthClamps }) {
  const foldCount = Math.max(...folds) + 1;
  const results = [];
  for (let fold = 0; fold < foldCount; fold += 1) {
    const trainSubset = rows.filter((_, index) => folds[index] !== fold);
    const testSubset = rows.filter((_, index) => folds[index] === fold);
    if (!trainSubset.length || !testSubset.length) continue;
    const hedonic = fitHedonic(trainSubset, { lambda });
    const field = buildField(trainSubset, hedonic, bandwidthClamps);
    const logSmear = computeLogSmear(trainSubset, hedonic, field);
    for (const row of testSubset) {
      const surface = row.hasCoords ? fieldAt(row.x, row.y, field, row.clusterId) : emptyFieldResult(field);
      const predLog = hedonic.predictLog(row) + surface.residualLog + logSmear;
      results.push({ tier: row.tier, yLog: row.logPricePerSqm, predLog, actual: row.pricePerSqm });
    }
  }
  return results;
}

function computeLogSmear(rows, hedonic, field) {
  const factors = [];
  for (const row of rows) {
    const surface = row.hasCoords ? fieldAt(row.x, row.y, field, row.clusterId) : emptyFieldResult(field);
    const residual = row.logPricePerSqm - (hedonic.predictLog(row) + surface.residualLog);
    if (!Number.isFinite(residual)) continue;
    factors.push(Math.exp(residual));
  }
  if (!factors.length) return 0;
  const smear = factors.reduce((sum, value) => sum + value, 0) / factors.length;
  return Math.log(clamp(smear, 0.8, 1.25));
}

function scoreCorpusRow(row, model) {
  const surface = row.hasCoords ? fieldAt(row.x, row.y, model.field, row.clusterId) : emptyFieldResult(model.field);
  const predLog = model.hedonic.predictLog(row) + surface.residualLog + model.logSmear;
  const prediction = Math.max(1, Math.exp(predLog));
  const actual = row.pricePerSqm;
  const residual = actual - prediction;
  const interval = conformalIntervalLog(model.conformal, row.tier, { predLog });
  const confidence = clamp(surface.confidence * geocodePenaltyFor(row.tier), EMPTY_FIELD_CONFIDENCE, 1);

  const zScore = (predLog - Math.log(actual)) / surface.spreadLog;

  return {
    listingId: row.id,
    actualPricePerSqm: roundMetric(actual),
    predictedPricePerSqm: roundMetric(prediction),
    predictedLoPricePerSqm: interval ? roundMetric(Math.exp(interval.loLog)) : null,
    predictedHiPricePerSqm: interval ? roundMetric(Math.exp(interval.hiLog)) : null,
    residualPricePerSqm: roundMetric(residual),
    deltaPercent: roundMetric((100 * residual) / prediction),
    zScore: roundMetric(zScore),
    confidence: roundMetric(confidence),
    nearbyComps500m: surface.samples500m,
  };
}
