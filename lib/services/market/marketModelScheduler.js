/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';

import { env } from '../../shared/env.js';
import { tableExists } from '../../shared/sqlite.js';
import { gbmFeatureNames, hedonicTermNames } from '../scoring/hedonicFeatures.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { isRetrainDisabled, marketModelIntervalSeconds } from './retrainPolicy.js';
import logger from '../logger.js';
import { completeWork, enqueueWork, registerHandler, startWorker } from '../pipeline/workQueue.js';

const MODEL_RUNNER = fileURLToPath(new URL('../../../tools/market/marketModel.js', import.meta.url));
const WORK_KIND = 'market-model';
const WORKER_NAME = 'market-model';

export function startMarketModelScheduler() {
  if (isRetrainDisabled()) {
    logger.info('Market model retraining disabled (FREDY_MARKET_MODEL_INTERVAL_SECONDS=0).');
    return null;
  }
  const expression = env('FREDY_MARKET_MODEL_CRON');
  if (!cron.validate(expression)) throw new Error(`Invalid FREDY_MARKET_MODEL_CRON: ${expression}`);

  registerHandler(WORK_KIND, {
    name: WORKER_NAME,
    timeoutMs: () => env('FREDY_MARKET_MODEL_RUN_TIMEOUT_MS'),
    maxAttempts: () => env('FREDY_MARKET_MODEL_MAX_FAILURES'),
    startedMessage: 'Durable market-model worker started.',
    handler: async (item) => {
      await runMarketModelProcess();
      completeWork(WORK_KIND, item.key, { action: 'trained', code: 'trained' });
    },
  });
  const worker = startWorker(WORK_KIND);
  enqueueRetrainIfFeatureSpaceMoved();

  cron.schedule(expression, () => enqueueMarketModelRun());
  logger.info(
    `Market model work scheduled: ${expression} ` +
      `(FREDY_MARKET_MODEL_INTERVAL_SECONDS=${marketModelIntervalSeconds()})`,
  );
  return worker;
}

function enqueueRetrainIfFeatureSpaceMoved() {
  const expected = { ridge: hedonicTermNames().length, gbm: gbmFeatureNames().length };
  const db = SqliteConnection.getConnection();
  if (!tableExists(db, 'homeserver_models')) return;
  const stored = db
    .prepare(
      `SELECT family,
              CASE WHEN json_valid(artifact_json)
                   THEN json_array_length(artifact_json, '$.beta') END AS beta_length,
              CASE WHEN json_valid(artifact_json)
                   THEN json_array_length(artifact_json, '$.featureNames') END AS feature_names_length
       FROM homeserver_models WHERE family IN ('ridge', 'gbm')`,
    )
    .all();
  const ridge = stored.find((row) => row.family === 'ridge');
  const gbm = stored.find((row) => row.family === 'gbm');
  const matches = ridge?.beta_length === expected.ridge && gbm?.feature_names_length === expected.gbm;
  if (matches) return;
  logger.warn(
    `Stored market model artifacts do not match the shipped feature space ` +
      `(ridge ${ridge?.beta_length ?? 'none'}/${expected.ridge}, ` +
      `gbm ${gbm?.feature_names_length ?? 'none'}/${expected.gbm}); enqueuing a retrain.`,
  );
  enqueueWork(
    WORK_KIND,
    `featurespace-${expected.ridge}-${expected.gbm}`,
    { scheduledAt: Date.now() },
    { mode: 'ignore' },
  );
}

function enqueueMarketModelRun(now = new Date()) {
  const scheduledAt = now.getTime();
  const key = String(Math.floor(scheduledAt / (marketModelIntervalSeconds() * 1000)));
  enqueueWork(WORK_KIND, key, { scheduledAt }, { mode: 'ignore' });
}

export function runMarketModelProcess() {
  const timeoutMs = env('FREDY_MARKET_MODEL_RUN_TIMEOUT_MS');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MODEL_RUNNER, 'run'], {
      env: process.env,
      stdio: 'inherit',
    });
    let timedOut = false;
    let forceKillTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (timedOut) {
        reject(new Error(`Market model retrain exceeded ${timeoutMs}ms and was terminated`));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Market model retrain exited with code ${code ?? 'unknown'} (${signal || 'no signal'})`));
      }
    });
  });
}
