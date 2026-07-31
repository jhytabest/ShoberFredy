/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * The /metrics HTTP endpoint and the database handle behind it.
 *
 * Serving a scrape is strictly read-only: the handle is opened with
 * query_only, and the map layers Grafana reads are written by the retrain
 * (lib/services/market/surfaceExport.js), never from here — a Prometheus
 * scrape that writes files turns a monitoring outage into a data outage.
 *
 * The application's single health interface lives at /health on the main API
 * port; this process only serves /metrics.
 */

import http from 'node:http';

import { env } from '../../../shared/env.js';
import { resolveDbPath, openToolDb } from '../marketDb.js';
import { collectMetrics, emitExporterStatus } from './registry.js';

let config = null;
let runtimeHealthSnapshot = null;
let collectionErrors = 0;

// The database is created by the main app and mounted read-only here; open
// lazily and reopen after errors so a fresh deploy (no db yet) or a WAL
// handover around app restarts degrades to exporter_up=0 instead of a crash
// loop.
let db = null;

function getDb() {
  if (db) return db;
  db = openToolDb(config.dbPath, { readonly: true, fileMustExist: true });
  return db;
}

function resetDb() {
  try {
    db?.close();
  } catch {
    // A handle that cannot even be closed is exactly the one to drop.
  }
  db = null;
}

/**
 * Receive the main process's runtime state (geocoder health, worker heartbeats,
 * per-provider discovery freshness). The exporter is a separate process and
 * cannot observe them directly, so they arrive over IPC and are published with
 * their own age, which lets a stale snapshot be told apart from a healthy one.
 *
 * Every field is named here rather than spread: a sender that grows a field its
 * collector cannot see produces no series and no error, which is how
 * `providers` shipped as a metric that silently did not exist.
 *
 * @param {object} snapshot
 */
export function updateRuntimeHealthSnapshot(snapshot) {
  runtimeHealthSnapshot = {
    receivedAt: Date.now(),
    capturedAt: Number(snapshot?.capturedAt) || 0,
    geocoding: snapshot?.geocoding || null,
    workers: snapshot?.workers || null,
    providers: snapshot?.providers || null,
  };
}

/**
 * Start the metrics HTTP server. Idempotent per process.
 *
 * @param {{dbPath?: string, port?: number}} [options]
 * @returns {Promise<import('node:http').Server|null>} the listening server,
 *   or null when the exporter is disabled (port 0).
 */
export async function startMetricsExporter(options = {}) {
  const port = options.port ?? env('FREDY_MARKET_EXPORTER_PORT');
  if (!port) return null;

  config = {
    dbPath: options.dbPath || (await resolveDbPath()),
    port,
  };

  const server = http.createServer((request, response) => {
    if (request.url !== '/metrics') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found\n');
      return;
    }

    try {
      const body = collectMetrics({ db: getDb(), runtimeSnapshot: runtimeHealthSnapshot, collectionErrors });
      response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      response.end(body);
    } catch (error) {
      collectionErrors += 1;
      resetDb();
      // Still answer 200: Prometheus needs to record exporter_up=0 as a sample,
      // and an HTTP error would only be visible as a scrape failure.
      response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      response.end(collectDownMetrics(error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', resolve);
  });
  return server;
}

function collectDownMetrics(error) {
  const lines = [];
  emitExporterStatus(lines, { up: 0, collectionErrors });
  return `# exporter error: ${String(error?.message || error)}\n${lines.join('\n')}\n`;
}
