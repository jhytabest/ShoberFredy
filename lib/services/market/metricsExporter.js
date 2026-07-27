/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Prometheus exporter for the Shoberfredy listings database and market model.
 *
 * Serves /metrics (Prometheus text format) from a read-only database handle.
 * The application's single health interface lives at /health on the main API
 * port. Started in-process by index.js (single-container mode) or standalone
 * via tools/market/marketExporter.js.
 *
 * Env: FREDY_MARKET_DB_PATH, FREDY_MARKET_EXPORTER_PORT (default 9217, 0 disables)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeAddress, addressKey } from '../geocoding/address.js';
import { getMigrationStatus } from '../storage/migrations/migrate.js';
import { resolveDbPath, openToolDb } from './marketDb.js';

let config = null;
let runtimeHealthSnapshot = null;
let exporterCollectionErrors = 0;

const STALE_JOB_THRESHOLD_SECONDS = 7200;

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
    // ignore
  }
  db = null;
}

function collectDownMetrics(error) {
  const lines = [];
  addHeader(lines, 'fredy_market_exporter_up', 'gauge', 'Whether the market exporter can read the listings database.');
  metric(lines, 'fredy_market_exporter_up', 0);
  addHeader(
    lines,
    'fredy_market_last_scrape_timestamp_seconds',
    'gauge',
    'Unix timestamp of the latest market exporter scrape.',
  );
  metric(lines, 'fredy_market_last_scrape_timestamp_seconds', Math.floor(Date.now() / 1000));
  addHeader(
    lines,
    'fredy_market_collection_errors_total',
    'counter',
    'Metrics collection failures since exporter start.',
  );
  metric(lines, 'fredy_market_collection_errors_total', exporterCollectionErrors);
  return `# exporter error: ${String(error?.message || error)}\n${lines.join('\n')}\n`;
}

export function updateRuntimeHealthSnapshot(snapshot) {
  runtimeHealthSnapshot = {
    receivedAt: Date.now(),
    capturedAt: Number(snapshot?.capturedAt) || 0,
    geocoding: snapshot?.geocoding || null,
    workers: snapshot?.workers || null,
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
  const port = options.port ?? Number.parseInt(process.env.FREDY_MARKET_EXPORTER_PORT || '9217', 10);
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
      const body = collectMetrics();
      response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      response.end(body);
    } catch (error) {
      exporterCollectionErrors += 1;
      resetDb();
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

function collectMetrics() {
  const startedAt = performance.now();
  getDb();
  const listings = getListings();
  const cacheByAddress = getGeocodeCache();
  const enriched = listings.map((listing) => enrichListing(listing, cacheByAddress));
  const cleaned = enriched.filter((listing) => listing.cleaned);
  const visibleCleaned = cleaned.filter((listing) => !listing.isHidden);
  const activeCleaned = cleaned.filter((listing) => listing.isActive && !listing.isHidden);
  const lines = [];

  addHeader(lines, 'fredy_market_exporter_up', 'gauge', 'Whether the market exporter can read the listings database.');
  metric(lines, 'fredy_market_exporter_up', 1);
  addHeader(
    lines,
    'fredy_market_last_scrape_timestamp_seconds',
    'gauge',
    'Unix timestamp of the latest market exporter scrape.',
  );
  metric(lines, 'fredy_market_last_scrape_timestamp_seconds', Math.floor(Date.now() / 1000));
  addHeader(
    lines,
    'fredy_market_collection_errors_total',
    'counter',
    'Metrics collection failures since exporter start.',
  );
  metric(lines, 'fredy_market_collection_errors_total', exporterCollectionErrors);

  emitRuntimeSnapshotMetrics(lines);
  emitGeocodingHealthMetrics(lines);
  emitSchemaMetrics(lines);
  emitInventoryMetrics(lines, enriched);
  emitCleanedMarketMetrics(lines, cleaned, visibleCleaned, activeCleaned);
  emitFreshnessMetrics(lines, visibleCleaned);
  emitGeocodeMetrics(lines, enriched);
  emitOperationalMetrics(lines, enriched);
  emitPipelineMetrics(lines);
  emitWorkerMetrics(lines);
  emitDailyProviderMetrics(lines);
  emitPriceCutMetrics(lines);
  emitPredictionMetrics(lines);
  let listingGeojsonUp = 1;
  try {
    writeListingGeojson();
  } catch {
    listingGeojsonUp = 0;
  }
  addHeader(lines, 'fredy_listing_geojson_up', 'gauge', 'Whether the dashboard listing GeoJSON was refreshed.');
  metric(lines, 'fredy_listing_geojson_up', listingGeojsonUp);
  addHeader(lines, 'fredy_market_collection_duration_seconds', 'gauge', 'Duration of the latest metrics collection.');
  metric(lines, 'fredy_market_collection_duration_seconds', (performance.now() - startedAt) / 1000);

  return `${lines.join('\n')}\n`;
}

function emitRuntimeSnapshotMetrics(lines) {
  const ageSeconds = runtimeHealthSnapshot
    ? Math.max(0, (Date.now() - runtimeHealthSnapshot.receivedAt) / 1000)
    : Number.POSITIVE_INFINITY;
  addHeader(lines, 'fredy_runtime_snapshot_up', 'gauge', 'Whether runtime state is arriving from the main process.');
  metric(lines, 'fredy_runtime_snapshot_up', Number.isFinite(ageSeconds) && ageSeconds <= 30 ? 1 : 0);
  if (Number.isFinite(ageSeconds)) {
    addHeader(lines, 'fredy_runtime_snapshot_age_seconds', 'gauge', 'Age of the main-process runtime snapshot.');
    metric(lines, 'fredy_runtime_snapshot_age_seconds', ageSeconds);
  }
}

function emitPipelineMetrics(lines) {
  if (tableExists('parsing_queue')) {
    const queueRows = db
      .prepare(
        `SELECT queue_kind, status, stage, COUNT(*) AS count, MIN(discovered_at) AS oldest FROM parsing_queue GROUP BY queue_kind, status, stage`,
      )
      .all();
    addHeader(lines, 'fredy_parsing_queue_items', 'gauge', 'Durable parsing queue items by kind, status, and stage.');
    for (const row of queueRows) {
      metric(lines, 'fredy_parsing_queue_items', row.count, {
        kind: row.queue_kind,
        status: row.status,
        stage: row.stage,
      });
    }
    addHeader(lines, 'fredy_parsing_queue_oldest_age_seconds', 'gauge', 'Age of the oldest unfinished queue item.');
    for (const kind of ['live', 'backfill']) {
      const oldest = queueRows
        .filter(
          (row) => row.queue_kind === kind && !['completed', 'duplicate', 'dead', 'cancelled'].includes(row.status),
        )
        .map((row) => row.oldest)
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
      metric(lines, 'fredy_parsing_queue_oldest_age_seconds', oldest ? Math.max(0, (Date.now() - oldest) / 1000) : 0, {
        kind,
      });
    }
  }

  emitDurableQueueMetrics(lines, {
    table: 'detail_fetch_queue',
    metricName: 'fredy_detail_fetch_queue_items',
    ageMetricName: 'fredy_detail_fetch_queue_oldest_age_seconds',
    description: 'Detail-fetch queue items by status.',
    terminalStatuses: ['completed', 'inactive', 'cancelled'],
  });

  emitDurableQueueMetrics(lines, {
    table: 'rating_queue',
    metricName: 'fredy_rating_queue_items',
    ageMetricName: 'fredy_rating_queue_oldest_age_seconds',
    description: 'Market-rating queue items by status.',
    terminalStatuses: ['completed', 'cancelled'],
  });

  if (tableExists('listing_images')) {
    const images = db
      .prepare(
        `SELECT download_status, COUNT(*) AS count, MAX(COALESCE(byte_size, 0)) AS max_bytes FROM listing_images GROUP BY download_status`,
      )
      .all();
    addHeader(lines, 'fredy_listing_images', 'gauge', 'Captured listing images by download status.');
    addHeader(lines, 'fredy_listing_image_max_bytes', 'gauge', 'Largest stored listing image in bytes.');
    for (const row of images) metric(lines, 'fredy_listing_images', row.count, { status: row.download_status });
    metric(lines, 'fredy_listing_image_max_bytes', Math.max(0, ...images.map((row) => row.max_bytes || 0)));
  }

  if (tableExists('listing_extractions')) {
    const modes = db
      .prepare(
        `SELECT schema_version, COUNT(*) AS count,
                SUM(CASE WHEN llm_json IS NOT NULL THEN 1 ELSE 0 END) AS completed
         FROM listing_extractions GROUP BY schema_version`,
      )
      .all();
    addHeader(lines, 'fredy_listing_extractions', 'gauge', 'Required LLM extractions by schema and state.');
    for (const row of modes) {
      metric(lines, 'fredy_listing_extractions', row.completed, {
        schema: row.schema_version,
        state: 'complete',
      });
      metric(lines, 'fredy_listing_extractions', row.count - row.completed, {
        schema: row.schema_version,
        state: 'pending',
      });
    }
  }

  if (tableExists('llm_call_audit')) {
    const audit = db.prepare(`SELECT operation, outcome, COUNT(*) AS count FROM llm_call_audit GROUP BY 1, 2`).all();
    addHeader(lines, 'fredy_llm_calls', 'counter', 'Audited LLM HTTP calls by operation and outcome.');
    for (const row of audit) {
      metric(lines, 'fredy_llm_calls', row.count, { operation: row.operation, outcome: row.outcome });
    }
  }

  if (tableExists('notification_deliveries')) {
    const deliveries = db
      .prepare(`SELECT status, COUNT(*) AS count FROM notification_deliveries GROUP BY status`)
      .all();
    addHeader(lines, 'fredy_notification_deliveries', 'gauge', 'Notification outbox rows by status.');
    for (const status of ['pending', 'sent', 'cancelled']) {
      metric(lines, 'fredy_notification_deliveries', deliveries.find((row) => row.status === status)?.count ?? 0, {
        status,
      });
    }
    const notificationTiming = db
      .prepare(
        `SELECT
           MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending,
           MAX(CASE WHEN status = 'sent' THEN sent_at END) AS last_sent
         FROM notification_deliveries`,
      )
      .get();
    addHeader(
      lines,
      'fredy_notification_oldest_pending_age_seconds',
      'gauge',
      'Age of the oldest notification still awaiting successful delivery.',
    );
    metric(
      lines,
      'fredy_notification_oldest_pending_age_seconds',
      notificationTiming.oldest_pending ? Math.max(0, (Date.now() - notificationTiming.oldest_pending) / 1000) : 0,
    );
    if (notificationTiming.last_sent) {
      addHeader(
        lines,
        'fredy_notification_last_sent_timestamp_seconds',
        'gauge',
        'Unix timestamp of the latest successful notification delivery.',
      );
      metric(lines, 'fredy_notification_last_sent_timestamp_seconds', Math.floor(notificationTiming.last_sent / 1000));
    }
    const recentLatencies = db
      .prepare(
        `SELECT sent_at - created_at AS duration_ms
         FROM notification_deliveries
         WHERE status = 'sent' AND sent_at IS NOT NULL AND created_at >= ?`,
      )
      .all(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .map((row) => row.duration_ms / 1000);
    addHeader(
      lines,
      'fredy_notification_delivery_duration_seconds',
      'gauge',
      'Recent notification delivery duration quantiles from outbox creation to successful send.',
    );
    emitQuantiles(lines, 'fredy_notification_delivery_duration_seconds', recentLatencies);
  }

  if (tableExists('llm_budget_usage')) {
    const day = new Date();
    const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    const usage = db.prepare(`SELECT kind, count FROM llm_budget_usage WHERE day = ?`).all(dayStart);
    addHeader(
      lines,
      'fredy_llm_budget_used_requests',
      'gauge',
      'LLM requests consumed today from the daily budget, by queue kind.',
    );
    for (const kind of ['live', 'backfill']) {
      metric(lines, 'fredy_llm_budget_used_requests', usage.find((row) => row.kind === kind)?.count ?? 0, { kind });
    }
    const blocked = db.prepare(`SELECT value FROM pipeline_control WHERE name = 'llm_blocked_until'`).get()?.value;
    const blockedUntil = Number.parseInt(blocked || '', 10);
    addHeader(
      lines,
      'fredy_llm_budget_blocked',
      'gauge',
      'Whether LLM work is currently waiting on an upstream rate-limit reset.',
    );
    metric(lines, 'fredy_llm_budget_blocked', Number.isFinite(blockedUntil) && blockedUntil > Date.now() ? 1 : 0);
  }

  if (tableExists('processing_attempts')) {
    const attempts = db.prepare(`SELECT status, COUNT(*) AS count FROM processing_attempts GROUP BY status`).all();
    addHeader(lines, 'fredy_processing_attempts', 'gauge', 'Parser processing attempts by terminal state.');
    for (const row of attempts) metric(lines, 'fredy_processing_attempts', row.count, { status: row.status });
  }

  if (tableExists('pipeline_audit_events')) {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const events = db
      .prepare(`SELECT stage, action, COUNT(*) AS count FROM pipeline_audit_events WHERE created_at >= ? GROUP BY 1, 2`)
      .all(since);
    addHeader(lines, 'fredy_pipeline_audit_events_24h', 'gauge', 'Pipeline audit events in the last 24 hours.');
    for (const row of events) {
      metric(lines, 'fredy_pipeline_audit_events_24h', row.count, { stage: row.stage, action: row.action });
    }
  }
}

function emitWorkerMetrics(lines) {
  const health = runtimeHealthSnapshot?.workers;
  if (!health?.workers?.length) return;
  addHeader(lines, 'fredy_worker_healthy', 'gauge', 'Whether an in-process worker heartbeat is healthy.');
  addHeader(lines, 'fredy_worker_active_seconds', 'gauge', 'Seconds spent on the current worker item.');
  addHeader(lines, 'fredy_worker_heartbeat_age_seconds', 'gauge', 'Seconds since the worker heartbeat advanced.');
  addHeader(lines, 'fredy_worker_items_total', 'counter', 'Worker items completed or failed since process start.');
  addHeader(
    lines,
    'fredy_worker_loop_restarts_total',
    'counter',
    'Unexpected worker-loop restarts since process start.',
  );
  for (const worker of health.workers) {
    const labels = { worker: worker.name };
    metric(lines, 'fredy_worker_healthy', worker.healthy ? 1 : 0, labels);
    metric(lines, 'fredy_worker_active_seconds', worker.activeAgeMs / 1000, labels);
    metric(lines, 'fredy_worker_heartbeat_age_seconds', worker.heartbeatAgeMs / 1000, labels);
    metric(lines, 'fredy_worker_items_total', worker.completedItems, { ...labels, outcome: 'completed' });
    metric(lines, 'fredy_worker_items_total', worker.failedItems, { ...labels, outcome: 'failed' });
    metric(lines, 'fredy_worker_loop_restarts_total', worker.loopRestarts, labels);
  }
}

function emitDurableQueueMetrics(lines, options) {
  if (!tableExists(options.table)) return;
  const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM ${options.table} GROUP BY status`).all();
  addHeader(lines, options.metricName, 'gauge', options.description);
  for (const row of rows) metric(lines, options.metricName, row.count, { status: row.status });

  const placeholders = options.terminalStatuses.map(() => '?').join(', ');
  const oldest = db
    .prepare(`SELECT MIN(created_at) AS oldest FROM ${options.table} WHERE status NOT IN (${placeholders})`)
    .get(...options.terminalStatuses)?.oldest;
  addHeader(lines, options.ageMetricName, 'gauge', `Age of the oldest unfinished item in ${options.table}.`);
  metric(lines, options.ageMetricName, Number.isFinite(oldest) ? Math.max(0, (Date.now() - oldest) / 1000) : 0);
}

function emitSchemaMetrics(lines) {
  const status = getMigrationStatus(db);
  addHeader(
    lines,
    'fredy_database_schema_up_to_date',
    'gauge',
    'Whether every migration shipped by this build is applied.',
  );
  metric(lines, 'fredy_database_schema_up_to_date', status.upToDate ? 1 : 0, {
    latest_applied: status.latestApplied ?? 'none',
    latest_expected: status.latestExpected ?? 'none',
  });
  addHeader(lines, 'fredy_database_schema_migrations', 'gauge', 'Database migration counts by state.');
  metric(lines, 'fredy_database_schema_migrations', status.appliedCount, { state: 'applied' });
  metric(lines, 'fredy_database_schema_migrations', status.expectedCount, { state: 'expected' });
}

function getListings() {
  if (!tableExists('listings')) return [];
  return db
    .prepare(
      `
      SELECT
        id,
        created_at,
        provider,
        job_id,
        price,
        size,
        rooms,
        title,
        description,
        address,
        is_active,
        manually_deleted,
        latitude,
        longitude,
        distance_to_destination
      FROM listings
      `,
    )
    .all();
}

function getGeocodeCache() {
  if (!tableExists('homeserver_geocode_cache')) return new Map();

  return new Map(
    db
      .prepare(
        `
        SELECT address_key, status, accuracy
        FROM homeserver_geocode_cache
        `,
      )
      .all()
      .map((row) => [row.address_key, row]),
  );
}

function enrichListing(row, cacheByAddress) {
  const price = numberOrNull(row.price);
  const size = numberOrNull(row.size);
  const rooms = numberOrNull(row.rooms);
  const hasCoordinates = validCoordinate(row.latitude, row.longitude);
  const address = normalizeAddress(row.address);
  const addressKeyValue = addressKey(address);
  const cache = cacheByAddress.get(addressKeyValue) || null;
  const pricePerSqm = price && size ? price / size : null;
  const cleaned =
    price != null &&
    size != null &&
    price > 0 &&
    size >= 10 &&
    size <= 400 &&
    pricePerSqm != null &&
    pricePerSqm >= 3 &&
    pricePerSqm <= 150 &&
    address.length > 0 &&
    hasCoordinates;

  return {
    ...row,
    price,
    size,
    rooms,
    pricePerSqm,
    address,
    addressKey: addressKeyValue,
    isActive: row.is_active === 1,
    isHidden: row.manually_deleted === 1,
    hasCoordinates,
    cleaned,
    geocodeQuality: cache?.status === 'ok' ? cache.accuracy : cache?.status || inferGeocodeQuality(address),
  };
}

/*
 * Geocoding health: pipeline runs abort (nothing stored) while the geocoder
 * is unavailable, so this gauge is the primary alert signal for "Fredy is
 * running but not ingesting". Only meaningful in-process (single-container
 * mode); the standalone exporter CLI reports its own process state.
 */
function emitGeocodingHealthMetrics(lines) {
  const health = runtimeHealthSnapshot?.geocoding;
  addHeader(
    lines,
    'fredy_geocoding_healthy',
    'gauge',
    'Whether the geocoder is usable (1) or pipeline runs are aborting (0: missing key, quota, transport).',
  );
  metric(lines, 'fredy_geocoding_healthy', health?.healthy ? 1 : 0);
  if (health?.lastUnavailableAt > 0) {
    addHeader(
      lines,
      'fredy_geocoding_last_unavailable_timestamp_seconds',
      'gauge',
      'Unix timestamp of the last geocoder unavailability.',
    );
    metric(lines, 'fredy_geocoding_last_unavailable_timestamp_seconds', Math.floor(health.lastUnavailableAt / 1000));
  }
}

function emitInventoryMetrics(lines, listings) {
  addHeader(
    lines,
    'fredy_listings_total',
    'gauge',
    'Listings by visibility, activity, and cleaned market-model eligibility.',
  );
  for (const [key, rows] of groupBy(listings, (row) =>
    labelKey({
      visibility: row.isHidden ? 'hidden' : 'visible',
      activity: row.isActive ? 'active' : 'inactive',
      cleaned: row.cleaned ? 'true' : 'false',
    }),
  )) {
    metric(lines, 'fredy_listings_total', rows.length, parseLabelKey(key));
  }

  addHeader(lines, 'fredy_market_cleaned_ratio', 'gauge', 'Share of all listings eligible for the market model.');
  metric(lines, 'fredy_market_cleaned_ratio', ratio(listings.filter((row) => row.cleaned).length, listings.length));
}

function emitCleanedMarketMetrics(lines, cleaned, visibleCleaned, activeCleaned) {
  addHeader(lines, 'fredy_market_cleaned_listings', 'gauge', 'Cleaned listings eligible for market analysis.');
  metric(lines, 'fredy_market_cleaned_listings', cleaned.length, { scope: 'all_training' });
  metric(lines, 'fredy_market_cleaned_listings', visibleCleaned.length, { scope: 'all_visible' });
  metric(lines, 'fredy_market_cleaned_listings', activeCleaned.length, { scope: 'active_visible' });

  addHeader(lines, 'fredy_market_price_eur', 'gauge', 'Cleaned listing monthly price quantiles in EUR.');
  emitQuantiles(
    lines,
    'fredy_market_price_eur',
    cleaned.map((row) => row.price),
  );

  addHeader(
    lines,
    'fredy_market_price_per_sqm_eur',
    'gauge',
    'Cleaned listing monthly price per square meter quantiles in EUR.',
  );
  emitQuantiles(
    lines,
    'fredy_market_price_per_sqm_eur',
    cleaned.map((row) => row.pricePerSqm),
  );

  const medianPpsqm = quantile(
    cleaned.map((row) => row.pricePerSqm),
    0.5,
  );
  const activeMedianPpsqm = quantile(
    activeCleaned.map((row) => row.pricePerSqm),
    0.5,
  );

  addHeader(
    lines,
    'fredy_market_pressure_index',
    'gauge',
    'Active cleaned median EUR per square meter divided by all cleaned median EUR per square meter.',
  );
  metric(lines, 'fredy_market_pressure_index', medianPpsqm ? activeMedianPpsqm / medianPpsqm : 0);
}

function emitFreshnessMetrics(lines, cleaned) {
  const now = Date.now();
  addHeader(
    lines,
    'fredy_market_new_listings',
    'gauge',
    'Cleaned visible listings created within a rolling time window.',
  );
  for (const window of [
    ['1h', 60 * 60 * 1000],
    ['1d', 24 * 60 * 60 * 1000],
    ['7d', 7 * 24 * 60 * 60 * 1000],
    ['30d', 30 * 24 * 60 * 60 * 1000],
  ]) {
    metric(
      lines,
      'fredy_market_new_listings',
      cleaned.filter((row) => Number.isFinite(row.created_at) && now - row.created_at <= window[1]).length,
      { window: window[0] },
    );
  }
}

function emitGeocodeMetrics(lines, listings) {
  addHeader(
    lines,
    'fredy_market_geocode_quality_listings',
    'gauge',
    'Listings by Google geocode cache accuracy or address-derived precision fallback.',
  );
  for (const [quality, rows] of groupBy(listings, (row) => row.geocodeQuality)) {
    metric(lines, 'fredy_market_geocode_quality_listings', rows.length, { quality });
  }
}

function emitOperationalMetrics(lines, listings) {
  const now = Date.now();

  if (tableExists('jobs')) {
    const jobs = db
      .prepare(`SELECT id, name, coalesce(enabled, 0) AS enabled, coalesce(last_run_at, 0) AS last_run_at FROM jobs`)
      .all();
    const enabledJobs = jobs.filter((job) => job.enabled === 1);
    const enabledAges = enabledJobs.map((job) => Math.max(0, Math.floor((now - job.last_run_at) / 1000)));

    addHeader(lines, 'fredy_jobs_enabled', 'gauge', 'Enabled scrape jobs.');
    metric(lines, 'fredy_jobs_enabled', enabledAges.length);
    addHeader(lines, 'fredy_job_age_seconds', 'gauge', 'Age of the most recent run for each enabled scrape job.');
    for (const job of enabledJobs) {
      metric(lines, 'fredy_job_age_seconds', Math.max(0, Math.floor((now - job.last_run_at) / 1000)), {
        job_id: job.id,
        job_name: shortenLabel(job.name || job.id, 60),
      });
    }
    addHeader(lines, 'fredy_jobs_stale', 'gauge', 'Enabled jobs whose last run is older than the staleness threshold.');
    metric(lines, 'fredy_jobs_stale', enabledAges.filter((age) => age > STALE_JOB_THRESHOLD_SECONDS).length, {
      threshold_seconds: String(STALE_JOB_THRESHOLD_SECONDS),
    });
    if (enabledAges.length > 0) {
      addHeader(lines, 'fredy_job_max_age_seconds', 'gauge', 'Age of the least recently run enabled job.');
      metric(lines, 'fredy_job_max_age_seconds', Math.max(...enabledAges));
    }
  }

  const newestListing = listings.reduce(
    (newest, row) => (Number.isFinite(row.created_at) && row.created_at > newest ? row.created_at : newest),
    0,
  );
  if (newestListing > 0) {
    addHeader(lines, 'fredy_newest_listing_age_seconds', 'gauge', 'Age of the most recently ingested listing.');
    metric(lines, 'fredy_newest_listing_age_seconds', Math.max(0, Math.floor((now - newestListing) / 1000)));
  }

  // Restricted to providers this build can actually scrape. Retired providers
  // keep their historical listings forever, so grouping over the whole table
  // published series whose age only ever grew — noise that looks like an
  // outage but describes a provider that was removed on purpose.
  const activeProviders = installedProviderIds();
  const providerRows = db
    .prepare(
      `SELECT provider, MAX(created_at) AS newest
       FROM listings
       WHERE provider IS NOT NULL AND provider != ''
       GROUP BY provider`,
    )
    .all()
    .filter((row) => activeProviders.has(row.provider));
  addHeader(lines, 'fredy_provider_newest_listing_age_seconds', 'gauge', 'Age of the newest listing by provider.');
  for (const row of providerRows) {
    metric(lines, 'fredy_provider_newest_listing_age_seconds', Math.max(0, (now - row.newest) / 1000), {
      provider: row.provider,
    });
  }

  addHeader(lines, 'fredy_listings_missing_coordinates', 'gauge', 'Listings without valid coordinates by scope.');
  const visible = listings.filter((row) => !row.isHidden);
  const activeVisible = visible.filter((row) => row.isActive);
  metric(lines, 'fredy_listings_missing_coordinates', visible.filter((row) => !row.hasCoordinates).length, {
    scope: 'visible',
  });
  metric(lines, 'fredy_listings_missing_coordinates', activeVisible.filter((row) => !row.hasCoordinates).length, {
    scope: 'active_visible',
  });

  if (tableExists('homeserver_geocode_cache')) {
    addHeader(lines, 'fredy_geocode_cache_entries', 'gauge', 'Geocode cache entries by status.');
    const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM homeserver_geocode_cache GROUP BY status`).all();
    for (const row of rows) {
      metric(lines, 'fredy_geocode_cache_entries', row.n, { status: row.status });
    }
  }
}

/*
 * Daily scrape volume per provider over the last 45 days, main (notifying)
 * jobs only — the scraper-health funnel.
 */
function emitDailyProviderMetrics(lines) {
  if (!tableExists('jobs')) return;
  const rows = db
    .prepare(
      `
      SELECT date(l.created_at / 1000, 'unixepoch') AS date, l.provider, count(*) AS n
      FROM listings l
      JOIN jobs j ON j.id = l.job_id
      WHERE json_array_length(j.notification_adapter) > 0
        AND l.created_at >= (strftime('%s', 'now') - 45 * 86400) * 1000
      GROUP BY 1, 2
      `,
    )
    .all();
  addHeader(
    lines,
    'fredy_market_daily_listings_by_provider',
    'gauge',
    'Main-job listings first seen per day and provider (scraper health funnel).',
  );
  for (const row of rows) {
    metric(lines, 'fredy_market_daily_listings_by_provider', row.n, { date: row.date, provider: row.provider });
  }
}

/*
 * Price-cut tracker: a portal edit re-inserts the same link with a new hash,
 * so "same link, lower latest price" is a repricing event — a motivated
 * landlord and often a stronger signal than the model delta.
 */
function emitPriceCutMetrics(lines) {
  if (!tableExists('jobs')) return;
  const cuts = db
    .prepare(
      `
      WITH versions AS (
        SELECT l.link, l.title, l.price, l.created_at,
               first_value(l.price) OVER w AS first_price,
               last_value(l.price) OVER w AS last_price,
               max(l.created_at) OVER (PARTITION BY l.link) AS last_seen,
               count(*) OVER (PARTITION BY l.link) AS versions
        FROM listings l
        JOIN jobs j ON j.id = l.job_id
        WHERE json_array_length(j.notification_adapter) > 0
          AND l.link IS NOT NULL AND l.link != '' AND l.price > 0
        WINDOW w AS (PARTITION BY l.link ORDER BY l.created_at
                     ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
      )
      SELECT link, title, first_price, last_price, last_seen,
             100.0 * (last_price - first_price) / first_price AS cut_percent
      FROM versions
      WHERE versions > 1 AND last_price < first_price
      GROUP BY link
      `,
    )
    .all();

  const now = Date.now();
  addHeader(
    lines,
    'fredy_market_price_cuts',
    'gauge',
    'Main-job listings whose latest price is below their first price, within a rolling window of the latest version.',
  );
  for (const [window, windowMs] of [
    ['7d', 7 * 24 * 60 * 60 * 1000],
    ['30d', 30 * 24 * 60 * 60 * 1000],
  ]) {
    metric(lines, 'fredy_market_price_cuts', cuts.filter((cut) => now - cut.last_seen <= windowMs).length, { window });
  }

  addHeader(
    lines,
    'fredy_market_top_price_cut',
    'gauge',
    'Largest recent price cuts (value = cut in percent, negative).',
  );
  const top = cuts
    .filter((cut) => now - cut.last_seen <= 7 * 24 * 60 * 60 * 1000)
    .sort((a, b) => a.cut_percent - b.cut_percent)
    .slice(0, 5);
  top.forEach((cut, index) => {
    metric(lines, 'fredy_market_top_price_cut', cut.cut_percent, {
      rank: String(index + 1),
      title: shortenLabel(cut.title, 60),
      link: cut.link,
      first_price: String(roundMetric(cut.first_price)),
      last_price: String(roundMetric(cut.last_price)),
    });
  });
}

function emitPredictionMetrics(lines) {
  if (!tableExists('homeserver_listing_market_model') || !tableExists('homeserver_model_runs')) {
    return;
  }
  // Mid-upgrade databases (migration 26 not applied, no per-family runs yet)
  // simply have no prediction metrics until the first dual-model run lands.
  if (!columnExists('homeserver_model_runs', 'model_family')) return;
  if (!columnExists('homeserver_listing_market_model', 'model_family')) return;

  // Snapshot in one read transaction so a model rewrite committing in
  // between cannot yield a run id whose predictions are gone.
  const snapshot = db.transaction(() => {
    const runs = db
      .prepare(
        `
        SELECT id, model_version, model_family, training_rows, scored_rows, created_at, metrics_json
        FROM homeserver_model_runs r
        WHERE model_family IS NOT NULL
          AND created_at = (
            SELECT max(created_at) FROM homeserver_model_runs r2
            WHERE r2.model_family = r.model_family
          )
        ORDER BY model_family
        `,
      )
      .all();
    return runs.map((run) => ({
      run,
      predictions: db
        .prepare(
          `
          SELECT
            m.*,
            l.is_active,
            l.manually_deleted,
            l.address,
            l.latitude,
            l.longitude
          FROM homeserver_listing_market_model m
          JOIN listings l ON l.id = m.listing_id
          WHERE m.run_id = ? AND m.model_family = ?
          `,
        )
        .all(run.id, run.model_family),
    }));
  })();
  if (!snapshot.length) return;

  // Headers once; values per model family via the 'model' label.
  addHeader(lines, 'fredy_market_prediction_model_info', 'gauge', 'Latest market prediction model run metadata.');
  addHeader(
    lines,
    'fredy_market_prediction_model_created_timestamp_seconds',
    'gauge',
    'Unix timestamp for the latest market model run.',
  );
  addHeader(
    lines,
    'fredy_market_prediction_mae_eur_per_sqm',
    'gauge',
    'Median absolute prediction error of the latest model run in EUR per square meter.',
  );
  addHeader(
    lines,
    'fredy_market_model_error_percent',
    'gauge',
    'Out-of-sample model error by evaluation method (cv = spatially blocked cross-validation, naive = predict the global median).',
  );
  addHeader(
    lines,
    'fredy_market_model_interval',
    'gauge',
    'Conformal interval quality from the evaluation pass: target level, honest coverage, median width percent.',
  );
  addHeader(
    lines,
    'fredy_market_model_training_flats',
    'gauge',
    'Corpus composition of the latest model run (unique flats, trainable rows, exclusions).',
  );
  addHeader(
    lines,
    'fredy_market_prediction_scored_listings',
    'gauge',
    'Listings scored by the latest market prediction model.',
  );
  addHeader(
    lines,
    'fredy_market_prediction_price_per_sqm_eur',
    'gauge',
    'Actual and predicted EUR per square meter quantiles from the market model.',
  );
  addHeader(
    lines,
    'fredy_market_prediction_error_per_sqm_eur',
    'gauge',
    'Prediction residual quantiles in EUR per square meter.',
  );
  addHeader(lines, 'fredy_market_prediction_confidence', 'gauge', 'Prediction confidence quantiles from 0 to 1.');
  addHeader(
    lines,
    'fredy_market_top_listing',
    'gauge',
    'Best-priced active listings by model delta within a rolling window; value is the delta in percent.',
  );
  addHeader(
    lines,
    'fredy_market_delta_distribution',
    'gauge',
    'Visible scored listings bucketed by price delta percent (how mispriced the market currently is).',
  );

  for (const { run, predictions } of snapshot) {
    emitFamilyPredictionMetrics(lines, run, predictions);
  }

  // Daily history uses actual prices, identical across families — emit once.
  emitHistoryMetrics(lines, snapshot[0].predictions);
  // The surface layer is produced by the ridge family only.
  const ridgeRun = snapshot.find(({ run }) => run.model_family === 'ridge');
  if (ridgeRun) emitSurfaceMetrics(lines, ridgeRun.run.id);
}

function emitFamilyPredictionMetrics(lines, latestRun, rows) {
  const model = latestRun.model_family;
  const visibleRows = rows.filter((row) => row.manually_deleted !== 1);
  const activeRows = rows.filter((row) => row.is_active === 1 && row.manually_deleted !== 1);

  metric(lines, 'fredy_market_prediction_model_info', 1, {
    model,
    model_version: latestRun.model_version,
    run_id: latestRun.id,
  });
  metric(lines, 'fredy_market_prediction_model_created_timestamp_seconds', Math.floor(latestRun.created_at / 1000), {
    model,
  });

  let runMetrics;
  try {
    runMetrics = JSON.parse(latestRun.metrics_json || '{}');
  } catch {
    runMetrics = {};
  }
  metric(lines, 'fredy_market_prediction_mae_eur_per_sqm', Number(runMetrics.medianAbsoluteError), { model });

  const evaluation = runMetrics.evaluation || {};
  for (const [method, source] of [
    ['cv', evaluation.point],
    ['naive', evaluation.naive],
  ]) {
    if (Number.isFinite(source?.mdape)) {
      metric(lines, 'fredy_market_model_error_percent', source.mdape, { model, method, stat: 'mdape' });
    }
    if (Number.isFinite(source?.ppe10)) {
      metric(lines, 'fredy_market_model_error_percent', source.ppe10, { model, method, stat: 'ppe10' });
    }
  }
  const interval = evaluation.interval || {};
  metric(lines, 'fredy_market_model_interval', interval.level, { model, stat: 'level' });
  metric(lines, 'fredy_market_model_interval', interval.coverage, { model, stat: 'coverage' });
  metric(lines, 'fredy_market_model_interval', interval.medianWidthPercent, { model, stat: 'width_percent' });

  const corpus = runMetrics.corpus || {};
  metric(lines, 'fredy_market_model_training_flats', Number(corpus.uniqueFlats) || 0, { model, kind: 'unique' });
  metric(lines, 'fredy_market_model_training_flats', Number(corpus.rawRows) || 0, { model, kind: 'raw_rows' });
  metric(lines, 'fredy_market_model_training_flats', Number(corpus.trainableRows) || 0, { model, kind: 'trainable' });
  metric(lines, 'fredy_market_model_training_flats', Number(corpus.swapExcluded) || 0, {
    model,
    kind: 'swap_excluded',
  });
  metric(lines, 'fredy_market_model_training_flats', Number(corpus.unknownPriceType) || 0, {
    model,
    kind: 'unknown_price_type',
  });
  metric(lines, 'fredy_market_model_training_flats', Number(corpus.outlierExcluded) || 0, {
    model,
    kind: 'outlier_excluded',
  });

  metric(lines, 'fredy_market_prediction_scored_listings', rows.length, { model, scope: 'all_training' });
  metric(lines, 'fredy_market_prediction_scored_listings', visibleRows.length, { model, scope: 'all_visible' });
  metric(lines, 'fredy_market_prediction_scored_listings', activeRows.length, { model, scope: 'active_visible' });

  for (const [kind, selector] of [
    ['actual', (row) => row.actual_price_per_sqm],
    ['predicted', (row) => row.predicted_price_per_sqm],
  ]) {
    for (const [label, q] of [
      ['p10', 0.1],
      ['p25', 0.25],
      ['p50', 0.5],
      ['p75', 0.75],
      ['p90', 0.9],
    ]) {
      metric(lines, 'fredy_market_prediction_price_per_sqm_eur', quantile(rows.map(selector), q) || 0, {
        model,
        kind,
        quantile: label,
      });
    }
  }

  for (const [label, q] of [
    ['p25', 0.25],
    ['p50', 0.5],
    ['p75', 0.75],
  ]) {
    metric(
      lines,
      'fredy_market_prediction_error_per_sqm_eur',
      quantile(
        rows.map((row) => row.residual_price_per_sqm),
        q,
      ) || 0,
      { model, quantile: label },
    );
  }

  // Confidence exists for the ridge family only; empty for the GBM.
  const confidences = rows.map((row) => row.confidence).filter(Number.isFinite);
  if (confidences.length) {
    emitQuantiles(lines, 'fredy_market_prediction_confidence', confidences, { model });
  }

  emitTopListingMetrics(lines, activeRows, model);
  emitDeltaHistogram(lines, visibleRows, model);
}

function writeListingGeojson() {
  if (!tableExists('homeserver_listing_model_scores')) return;
  const outputDir = path.join(path.dirname(config.dbPath), 'surface');
  fs.mkdirSync(outputDir, { recursive: true });
  for (const model of ['gbm', 'ridge']) {
    const rows = db
      .prepare(
        `SELECT l.id, l.title, l.link, l.provider, l.created_at, l.price, l.size, l.rooms,
                l.latitude, l.longitude, s.actual_price_per_sqm, s.fair_price_per_sqm,
                s.fair_lo_price_per_sqm, s.fair_hi_price_per_sqm, s.delta_percent, s.comps_500m
         FROM homeserver_listing_model_scores s
         JOIN listings l ON l.id = s.listing_id
         WHERE s.model_family = ?
           AND l.is_active = 1 AND l.manually_deleted = 0 AND l.hidden_reason IS NULL
           AND l.latitude IS NOT NULL AND l.longitude IS NOT NULL
           AND l.latitude != -1 AND l.longitude != -1`,
      )
      .all(model);
    const features = rows.map((row) => {
      const monthlySaving = Math.max(0, (row.fair_price_per_sqm - row.actual_price_per_sqm) * row.size);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
        properties: {
          id: row.id,
          title: shortenLabel(row.title, 100),
          provider: row.provider,
          link: row.link,
          first_seen: new Date(row.created_at).toISOString(),
          rent_eur: roundMetric(row.price),
          size_sqm: roundMetric(row.size),
          rooms: roundMetric(row.rooms),
          asking_eur_per_sqm: roundMetric(row.actual_price_per_sqm),
          fair_eur_per_sqm: roundMetric(row.fair_price_per_sqm),
          fair_low_eur_per_sqm: roundMetric(row.fair_lo_price_per_sqm),
          fair_high_eur_per_sqm: roundMetric(row.fair_hi_price_per_sqm),
          delta_percent: roundMetric(row.delta_percent),
          saving_eur_per_month: roundMetric(monthlySaving),
          comps_500m: row.comps_500m,
          model,
          'marker-color': listingDeltaColor(row.delta_percent),
          'marker-size': monthlySaving >= 250 ? 'large' : monthlySaving >= 100 ? 'medium' : 'small',
        },
      };
    });
    const destination = path.join(outputDir, `listings-${model}.geojson`);
    const temporary = `${destination}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ type: 'FeatureCollection', features }));
    fs.renameSync(temporary, destination);
  }
}

function listingDeltaColor(deltaPercent) {
  if (deltaPercent <= -20) return '#16864b';
  if (deltaPercent <= -10) return '#55a868';
  if (deltaPercent < 10) return '#e5b94b';
  if (deltaPercent < 20) return '#e17c45';
  return '#c83e4d';
}

/*
 * Best-priced listings for the dashboard table: rank 1..5 within a rolling
 * window, minimum confidence 0.3 so junk geocodes don't top the chart.
 * Display values ride along as labels — the metric value is the delta %.
 */
function emitTopListingMetrics(lines, activeRows, model) {
  const now = Date.now();
  for (const [window, windowMs] of [
    ['1d', 24 * 60 * 60 * 1000],
    ['7d', 7 * 24 * 60 * 60 * 1000],
  ]) {
    const candidates = activeRows
      .filter(
        (row) =>
          // The GBM carries no confidence value; its interval columns are the
          // quality signal, so it passes the junk-geocode gate unfiltered.
          (row.confidence == null || row.confidence >= 0.3) &&
          Number.isFinite(row.listing_created_at) &&
          now - row.listing_created_at <= windowMs,
      )
      .sort((a, b) => a.delta_percent - b.delta_percent)
      .slice(0, 5);
    candidates.forEach((row, index) => {
      metric(lines, 'fredy_market_top_listing', row.delta_percent, {
        model,
        window,
        rank: String(index + 1),
        listing_id: row.listing_id,
        title: shortenLabel(row.title, 60),
        link: row.link || '',
        area: row.area,
        provider: row.provider,
        first_seen: new Date(row.listing_created_at).toISOString(),
        price_eur: String(roundMetric(row.target_rent_eur ?? row.actual_price_eur)),
        size_sqm: String(roundMetric(row.size_sqm)),
        rooms: String(roundMetric(row.rooms)),
        price_per_sqm: String(roundMetric(row.actual_price_per_sqm)),
        fair_per_sqm: String(roundMetric(row.predicted_price_per_sqm)),
        fair_lo_per_sqm:
          row.predicted_lo_price_per_sqm == null ? '' : String(roundMetric(row.predicted_lo_price_per_sqm)),
        fair_hi_per_sqm:
          row.predicted_hi_price_per_sqm == null ? '' : String(roundMetric(row.predicted_hi_price_per_sqm)),
        z_score: row.z_score == null ? '' : String(roundMetric(row.z_score)),
        confidence: row.confidence == null ? '' : String(roundMetric(row.confidence)),
        saving_eur_per_month: String(
          roundMetric(Math.max(0, (row.predicted_price_per_sqm - row.actual_price_per_sqm) * row.size_sqm)),
        ),
      });
    });
  }
}

function emitDeltaHistogram(lines, visibleRows, model) {
  const edges = [-60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60];
  for (let i = 0; i <= edges.length; i += 1) {
    const low = i === 0 ? -Infinity : edges[i - 1];
    const high = i === edges.length ? Infinity : edges[i];
    const count = visibleRows.filter((row) => row.delta_percent > low && row.delta_percent <= high).length;
    const label = i === 0 ? `<=${edges[0]}` : i === edges.length ? `>${edges.at(-1)}` : `${low}..${high}`;
    metric(lines, 'fredy_market_delta_distribution', count, {
      model,
      bucket: label,
      order: String(i).padStart(2, '0'),
    });
  }
}

/*
 * Daily history straight from the scored corpus (unique flats, cold-rent
 * basis), so the timeline exists immediately instead of waiting for
 * Prometheus to accumulate samples. One series per day, bounded window.
 */
function emitHistoryMetrics(lines, rows) {
  const days = 45;
  const byDay = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.listing_created_at)) continue;
    const date = new Date(row.listing_created_at).toISOString().slice(0, 10);
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(row);
  }
  const dates = [...byDay.keys()].sort().slice(-days);
  addHeader(
    lines,
    'fredy_market_daily_price_per_sqm',
    'gauge',
    'Daily EUR per square meter quantiles (cold-rent basis) of unique flats first seen on each day.',
  );
  addHeader(lines, 'fredy_market_daily_flats', 'gauge', 'Unique flats first seen on each day.');
  for (const date of dates) {
    const dayRows = byDay.get(date);
    const prices = dayRows.map((row) => row.actual_price_per_sqm);
    for (const [quantileLabel, quantileValue] of [
      ['p25', 0.25],
      ['p50', 0.5],
      ['p75', 0.75],
    ]) {
      metric(lines, 'fredy_market_daily_price_per_sqm', quantile(prices, quantileValue) || 0, {
        date,
        quantile: quantileLabel,
      });
    }
    metric(lines, 'fredy_market_daily_flats', dayRows.length, { date });
  }
}

function emitSurfaceMetrics(lines, runId) {
  if (!tableExists('homeserver_market_surface_cells')) return;
  const rows = db
    .prepare(
      `
      SELECT center_latitude, center_longitude, predicted_price_per_sqm, confidence, effective_samples, samples_500m
      FROM homeserver_market_surface_cells
      WHERE run_id = ?
      `,
    )
    .all(runId);

  // Geomap heatmap: 125m cells aggregated to ~500m to keep series cardinality
  // in the hundreds. Value = median predicted EUR/m2 of the finer cells.
  const AGG_DEG_LAT = 500 / 111320;
  const AGG_DEG_LNG = 500 / (111320 * Math.cos((52.52 * Math.PI) / 180));
  const buckets = new Map();
  for (const row of rows) {
    const key = `${Math.floor(row.center_latitude / AGG_DEG_LAT)}:${Math.floor(row.center_longitude / AGG_DEG_LNG)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  // Only the comps-density series is published per cell. The fair-price surface
  // itself is served to Grafana as surface.geojson, so emitting it here as well
  // duplicated ~160 high-cardinality series that no panel ever queried.
  addHeader(lines, 'fredy_market_surface_geo_samples', 'gauge', 'Local comps feeding each ~500m geomap grid cell.');
  for (const [key, cellRows] of buckets) {
    const [latIdx, lngIdx] = key.split(':').map(Number);
    const labels = {
      cell: key,
      latitude: String(roundMetric((latIdx + 0.5) * AGG_DEG_LAT)),
      longitude: String(roundMetric((lngIdx + 0.5) * AGG_DEG_LNG)),
    };
    metric(lines, 'fredy_market_surface_geo_samples', Math.max(...cellRows.map((row) => row.samples_500m)), labels);
  }

  addHeader(
    lines,
    'fredy_market_surface_cells',
    'gauge',
    'Street-scale market surface cells generated by the latest market model.',
  );
  metric(lines, 'fredy_market_surface_cells', rows.length);

  addHeader(
    lines,
    'fredy_market_surface_price_per_sqm_eur',
    'gauge',
    'Predicted EUR per square meter quantiles across generated market surface cells.',
  );
  emitQuantiles(
    lines,
    'fredy_market_surface_price_per_sqm_eur',
    rows.map((row) => row.predicted_price_per_sqm),
  );

  addHeader(
    lines,
    'fredy_market_surface_confidence',
    'gauge',
    'Confidence quantiles across generated market surface cells.',
  );
  emitQuantiles(
    lines,
    'fredy_market_surface_confidence',
    rows.map((row) => row.confidence),
  );

  addHeader(
    lines,
    'fredy_market_surface_effective_samples',
    'gauge',
    'Effective sample size quantiles across generated market surface cells.',
  );
  emitQuantiles(
    lines,
    'fredy_market_surface_effective_samples',
    rows.map((row) => row.effective_samples),
  );
}

function emitQuantiles(lines, name, values, extraLabels = {}) {
  for (const [label, q] of [
    ['p10', 0.1],
    ['p25', 0.25],
    ['p50', 0.5],
    ['p75', 0.75],
    ['p90', 0.9],
  ]) {
    metric(lines, name, quantile(values, q) || 0, { ...extraLabels, quantile: label });
  }
}

function addHeader(lines, name, type, help) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
}

function tableExists(name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

function columnExists(table, column) {
  return db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column) !== undefined;
}

function metric(lines, name, value, labels = {}) {
  if (!Number.isFinite(value)) return;
  const labelEntries = Object.entries(labels);
  const labelText = labelEntries.length
    ? `{${labelEntries.map(([key, labelValue]) => `${key}="${escapeLabel(labelValue)}"`).join(',')}}`
    : '';
  lines.push(`${name}${labelText} ${roundMetric(value)}`);
}

function groupBy(rows, keyFn) {
  const out = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const group = out.get(key);
    if (group) group.push(row);
    else out.set(key, [row]);
  }
  return out;
}

function quantile(values, q) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] === undefined) return sorted[base];
  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function ratio(part, total) {
  return total > 0 ? part / total : 0;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validCoordinate(latitude, longitude) {
  return (
    Number.isFinite(Number(latitude)) &&
    Number.isFinite(Number(longitude)) &&
    Number(latitude) !== -1 &&
    Number(longitude) !== -1
  );
}

function inferGeocodeQuality(address) {
  if (/\b\d{1,4}\s?[a-z]?\b.*\b\d{5}\b/.test(address) || /\b\d{5}\b.*\b\d{1,4}\s?[a-z]?\b/.test(address)) {
    return 'address_like';
  }
  if (/\b\d{5}\b/.test(address)) return 'postcode_like';
  return 'area_like';
}

function labelKey(labels) {
  return JSON.stringify(labels);
}

function parseLabelKey(key) {
  return JSON.parse(key);
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function shortenLabel(value, maxLength) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function roundMetric(value) {
  return Math.round(value * 1000000) / 1000000;
}

let cachedProviderIds = null;

/**
 * Provider ids this build can scrape, taken from the provider directory.
 * Each provider module is named after its own `metaInformation.id`, which is
 * the value stored in `listings.provider`. Resolved once per process.
 * @returns {Set<string>}
 */
function installedProviderIds() {
  if (cachedProviderIds) return cachedProviderIds;
  const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'provider');
  try {
    cachedProviderIds = new Set(
      fs
        .readdirSync(directory)
        .filter((file) => file.endsWith('.js'))
        .map((file) => file.slice(0, -3)),
    );
  } catch {
    // Unreadable provider directory must not take the exporter down; fall back
    // to publishing every provider rather than none.
    cachedProviderIds = null;
    return new Set(['immoscout', 'immowelt', 'kleinanzeigen', 'wgGesucht']);
  }
  return cachedProviderIds;
}
