/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';

import { env } from '../../shared/env.js';
import { isRetrainDisabled, marketModelIntervalSeconds } from './retrainPolicy.js';
import logger from '../logger.js';

const MODEL_RUNNER = fileURLToPath(new URL('../../../tools/market/marketModel.js', import.meta.url));
let running = false;

/**
 * Schedule non-overlapping model runs outside the API process. Ridge training
 * is CPU-bound JavaScript; keeping it in a child process prevents it from
 * blocking health checks and the durable listing workers.
 */
export function startMarketModelScheduler() {
  // Registering no cron at all is the honest form of "disabled": a cron that
  // fires and immediately declines would still log every night.
  if (isRetrainDisabled()) {
    logger.info('Market model retraining disabled (FREDY_MARKET_MODEL_INTERVAL_SECONDS=0); no cron scheduled.');
    return;
  }
  const expression = env('FREDY_MARKET_MODEL_CRON');
  if (!cron.validate(expression)) throw new Error(`Invalid FREDY_MARKET_MODEL_CRON: ${expression}`);
  cron.schedule(expression, async () => {
    if (running) {
      logger.warn('Skipping market model cron: the previous training run is still active.');
      return;
    }
    running = true;
    try {
      await runMarketModelProcess();
    } catch (error) {
      logger.error('Market model retrain failed; keeping previous model state', error);
    } finally {
      running = false;
    }
  });
  logger.info(
    `Market model training cron scheduled: ${expression} ` +
      `(FREDY_MARKET_MODEL_INTERVAL_SECONDS=${marketModelIntervalSeconds()})`,
  );
}

function runMarketModelProcess() {
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
