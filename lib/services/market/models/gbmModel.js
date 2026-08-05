/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { env } from '../../../shared/env.js';
import { gbmFeatureNames, gbmFeatureVector } from '../../scoring/hedonicFeatures.js';
import { assignFolds, buildEvalReport } from '../evaluation.js';
import { calibrateConformal, conformalIntervalLog } from '../conformal.js';
import { prepareModel, predictRow } from './gbmTreeEvaluator.js';
import { roundMetric } from '../stats.js';
import logger from '../../logger.js';

export const GBM_VERSION = 'gbm-quantile-v5';
export const GBM_FAMILY = 'gbm';
const GBM_QUANTILES = { lo: 0.1, mid: 0.5, hi: 0.9 };

const MIN_TRAINING_ROWS = 40;
const TRAIN_TIMEOUT_MS = 15 * 60 * 1000;
const TRAINER_PATH = fileURLToPath(new URL('../../../../tools/market/train_gbm.py', import.meta.url));

export async function trainGbmModel({ trainingRows, now, level, pythonBin }) {
  if (trainingRows.length < MIN_TRAINING_ROWS) return null;
  const python = pythonBin || env('FREDY_PYTHON_BIN');

  const payload = {
    featureNames: gbmFeatureNames(),
    X: trainingRows.map((row) => gbmFeatureVector(row).map((value) => (Number.isNaN(value) ? null : value))),
    y: trainingRows.map((row) => row.logPricePerSqm),
    paramsFold: assignFolds(trainingRows, { salt: 'gbm-params' }),
    calibFold: assignFolds(trainingRows, { salt: 'gbm-calibration' }),
    quantiles: GBM_QUANTILES,
    seed: 7,
  };

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fredy-gbm-'));
  const inputPath = path.join(workDir, `${randomUUID()}-input.json`);
  const outputPath = path.join(workDir, `${randomUUID()}-output.json`);
  let result;
  try {
    fs.writeFileSync(inputPath, JSON.stringify(payload));
    const run = await runPython(python, [TRAINER_PATH, '--input', inputPath, '--output', outputPath]);
    if (run.error) {
      logger.warn(`gbm trainer could not start (${run.error}); keeping previous gbm artifact`);
      return null;
    }
    if (run.code !== 0) {
      logger.error(`gbm trainer exited with code ${run.code}: ${run.stderr.slice(-2000)}`);
      return null;
    }
    result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } catch (error) {
    logger.error('gbm training failed; keeping previous gbm artifact', error);
    return null;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  if (!result?.ok) {
    logger.error(`gbm trainer reported failure: ${result?.error ?? 'no output'}`);
    return null;
  }

  try {
    for (const name of Object.keys(GBM_QUANTILES)) prepareModel(result.boosters[name]);
  } catch (error) {
    logger.error('gbm trainer produced an unevaluable model dump; discarding', error);
    return null;
  }

  const conformalRows = trainingRows
    .map((row, index) => ({
      tier: row.tier,
      yLog: row.logPricePerSqm,
      loLog: result.oof.loLog[index],
      hiLog: result.oof.hiLog[index],
      midLog: result.oof.midLog[index],
    }))
    .filter((row) => Number.isFinite(row.loLog) && Number.isFinite(row.hiLog) && Number.isFinite(row.midLog));

  const evaluation = {
    ...buildEvalReport({
      pairs: conformalRows.map((row) => ({
        actual: Math.exp(row.yLog),
        predicted: Math.exp(row.midLog),
      })),
      conformalRows,
      mode: 'cqr',
      level,
      trainingRows,
    }),
    params: result.params,
    bestIterations: result.bestIterations,
  };
  const conformal = calibrateConformal({ mode: 'cqr', level, rows: conformalRows });

  const logValues = trainingRows.map((row) => row.logPricePerSqm);
  const artifact = {
    version: GBM_VERSION,
    family: GBM_FAMILY,
    trainedAt: now,
    trainingRows: trainingRows.length,
    level,
    featureNames: payload.featureNames,
    quantiles: GBM_QUANTILES,
    params: result.params,
    bestIterations: result.bestIterations,
    boosters: result.boosters,
    conformal,
    featureImportance: result.featureImportance,
    trainingLogBand: {
      lo: Math.min(...logValues) - 0.5,
      hi: Math.max(...logValues) + 0.5,
    },
  };

  return { artifact, evaluation };
}

export function prepareGbmArtifact(artifact) {
  return {
    lo: prepareModel(artifact.boosters.lo),
    mid: prepareModel(artifact.boosters.mid),
    hi: prepareModel(artifact.boosters.hi),
  };
}

export function predictGbmLog(prepared, features) {
  const values = [
    predictRow(prepared.lo, features),
    predictRow(prepared.mid, features),
    predictRow(prepared.hi, features),
  ];
  values.sort((a, b) => a - b);
  return { loLog: values[0], midLog: values[1], hiLog: values[2] };
}

export function scoreGbmCorpusRow(row, prepared, artifact) {
  const features = gbmFeatureVector(row);
  const raw = predictGbmLog(prepared, features);
  const interval = conformalIntervalLog(artifact.conformal, row.tier, raw);
  const prediction = Math.max(1, Math.exp(raw.midLog));
  const actual = row.pricePerSqm;
  return {
    listingId: row.id,
    actualPricePerSqm: roundMetric(actual),
    predictedPricePerSqm: roundMetric(prediction),
    predictedLoPricePerSqm: interval ? roundMetric(Math.exp(interval.loLog)) : null,
    predictedHiPricePerSqm: interval ? roundMetric(Math.exp(interval.hiLog)) : null,
    residualPricePerSqm: roundMetric(actual - prediction),
    deltaPercent: roundMetric((100 * (actual - prediction)) / prediction),
    zScore: null,
    confidence: null,
    nearbyComps500m: null,
  };
}

function runPython(pythonBin, args) {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const child = spawn(pythonBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ code: null, stderr, error: `timeout after ${TRAIN_TIMEOUT_MS}ms` });
      }
    }, TRAIN_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ code: null, stderr, error: error.code === 'ENOENT' ? `${pythonBin} not found` : String(error) });
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ code, stderr });
      }
    });
  });
}
