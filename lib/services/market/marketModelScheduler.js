/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';

import logger from '../logger.js';

const MODEL_RUNNER = fileURLToPath(new URL('../../../tools/market/marketModel.js', import.meta.url));
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CRON = '0 2 * * *';
let running = false;

/**
 * Schedule non-overlapping model runs outside the API process. Ridge training
 * is CPU-bound JavaScript; keeping it in a child process prevents it from
 * blocking health checks and the durable listing workers.
 */
export function startMarketModelScheduler() {
  const expression = process.env.FREDY_MARKET_MODEL_CRON || DEFAULT_CRON;
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
  logger.info(`Market model training cron scheduled: ${expression}`);
}

function runMarketModelProcess() {
  const timeoutMs = positiveIntEnv('FREDY_MARKET_MODEL_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS);
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

function positiveIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
