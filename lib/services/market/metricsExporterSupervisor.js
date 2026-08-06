/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { env } from '../../shared/env.js';
import logger from '../logger.js';
import { getGeocodingHealth } from '../geocoding/geoCodingService.js';
import { providerDiscoveryHealth } from '../jobs/providerHealth.js';
import { getWorkerHealth } from '../pipeline/workerSupervisor.js';
import { serviceEventSnapshot } from '../monitoring/serviceEvents.js';
import { currentProxyUrl } from '../extractor/proxySettings.js';

const EXPORTER_RUNNER = fileURLToPath(new URL('../../../tools/market/marketExporter.js', import.meta.url));
const STARTUP_TIMEOUT_MS = 15_000;
const MAX_RESTART_DELAY_MS = 60_000;
const RUNTIME_SNAPSHOT_INTERVAL_MS = 10_000;

export function startMetricsExporterProcess() {
  const port = env('FREDY_MARKET_EXPORTER_PORT');
  if (!port) return null;

  const state = { child: null, restartDelayMs: 1000, restartTimer: null };
  launch(state, port);
  return state;
}

function launch(state, port) {
  const child = fork(EXPORTER_RUNNER, [], {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  state.child = child;
  let ready = false;
  let restartScheduled = false;
  let runtimeSnapshotTimer = null;

  const sendRuntimeSnapshot = async () => {
    if (!child.connected) return;
    const proxyUrl = await currentProxyUrl().catch(() => '');
    if (!child.connected) return;
    child.send({
      type: 'fredy_runtime_health',
      capturedAt: Date.now(),
      geocoding: getGeocodingHealth(),
      workers: getWorkerHealth(),
      providers: providerDiscoveryHealth(),
      events: serviceEventSnapshot(),
      proxy: { configured: Boolean(proxyUrl) },
    });
  };

  const startupTimeout = setTimeout(() => {
    if (ready) return;
    child.kill('SIGTERM');
    scheduleRestart(new Error(`Market metrics exporter did not become ready within ${STARTUP_TIMEOUT_MS}ms`));
  }, STARTUP_TIMEOUT_MS);

  child.on('message', (message) => {
    if (message?.type !== 'market_metrics_ready') return;
    ready = true;
    clearTimeout(startupTimeout);
    state.restartDelayMs = 1000;
    void sendRuntimeSnapshot();
    runtimeSnapshotTimer = setInterval(() => void sendRuntimeSnapshot(), RUNTIME_SNAPSHOT_INTERVAL_MS);
    runtimeSnapshotTimer.unref();
    logger.info(`Market metrics exporter listening on :${message.port}/metrics (isolated process)`);
  });

  const scheduleRestart = (reason) => {
    if (restartScheduled) return;
    restartScheduled = true;
    clearTimeout(startupTimeout);
    if (runtimeSnapshotTimer) clearInterval(runtimeSnapshotTimer);
    logger.error(`Market metrics exporter stopped; restarting in ${state.restartDelayMs}ms`, reason);
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      launch(state, port);
    }, state.restartDelayMs);
    state.restartDelayMs = Math.min(state.restartDelayMs * 2, MAX_RESTART_DELAY_MS);
  };

  child.once('error', (error) => scheduleRestart(error));
  child.once('exit', (code, signal) => {
    scheduleRestart(new Error(`Exporter exited with code ${code ?? 'unknown'} (${signal || 'no signal'})`));
  });
}
