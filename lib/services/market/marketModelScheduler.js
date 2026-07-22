/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import logger from '../logger.js';
import { initMarketModel, marketModelInitialDelayMs, marketModelIntervalSeconds } from './marketModel.js';

const MODEL_RUNNER = fileURLToPath(new URL('../../../tools/market/marketModel.js', import.meta.url));
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Schedule non-overlapping model runs outside the API process. Ridge training
 * is CPU-bound JavaScript; keeping it in a child process prevents it from
 * blocking health checks and the durable listing workers.
 */
export async function startMarketModelScheduler() {
  await initMarketModel();
  const intervalMs = marketModelIntervalSeconds() * 1000;
  const initialDelayMs = marketModelInitialDelayMs();

  const retrain = async () => {
    try {
      await runMarketModelProcess();
    } catch (error) {
      logger.error('Market model retrain failed; keeping previous model state', error);
    } finally {
      setTimeout(retrain, intervalMs);
    }
  };

  setTimeout(retrain, initialDelayMs);
  logger.info(
    `Market model retrain scheduled in ${Math.ceil(initialDelayMs / 1000)}s, then every ${Math.ceil(intervalMs / 1000)}s`,
  );
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
