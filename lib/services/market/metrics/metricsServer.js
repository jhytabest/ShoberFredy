/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import http from 'node:http';

import { env } from '../../../shared/env.js';
import { resolveDbPath, openToolDb } from '../marketDb.js';
import { collectMetrics, emitExporterStatus } from './registry.js';

// Prometheus scrapes this every 60s; a full collection is a 226 MB SQLite
// scan plus per-market artifact JSON.parse, which does not need repeating
// more often than the data underneath it plausibly changes. Cached just
// under the scrape interval rather than at it, so a scrape never returns
// something one whole interval older than it has to.
const CACHE_TTL_MS = 55_000;

let config = null;
let runtimeHealthSnapshot = null;
let collectionErrors = 0;
let cachedBody = null;
let cachedAt = 0;

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

// This rebuild is a whitelist, so it is also the place a runtime field can go
// missing: the supervisor sent `proxy` for a whole release while this function
// dropped it, which pinned fredy_proxy_ok to 0 and left its alert firing against
// a working proxy. A field added to the message in metricsExporterSupervisor.js
// has to be added here too, or nothing downstream will ever see it.
export function updateRuntimeHealthSnapshot(snapshot) {
  runtimeHealthSnapshot = {
    receivedAt: Date.now(),
    capturedAt: Number(snapshot?.capturedAt) || 0,
    geocoding: snapshot?.geocoding || null,
    workers: snapshot?.workers || null,
    providers: snapshot?.providers || null,
    proxy: snapshot?.proxy || null,
    events: snapshot?.events || [],
  };
}

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
      const now = Date.now();
      if (!cachedBody || now - cachedAt >= CACHE_TTL_MS) {
        cachedBody = collectMetrics({ db: getDb(), runtimeSnapshot: runtimeHealthSnapshot, collectionErrors });
        cachedAt = now;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      response.end(cachedBody);
    } catch (error) {
      collectionErrors += 1;
      resetDb();
      cachedBody = null;
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
  lines.push('# HELP service_check_up Standard operational checks exposed by services (1 healthy, 0 failed).');
  lines.push('# TYPE service_check_up gauge');
  lines.push('service_check_up{service="fredy",check="metrics_exporter",severity="critical"} 0');
  return `# exporter error: ${String(error?.message || error)}\n${lines.join('\n')}\n`;
}
