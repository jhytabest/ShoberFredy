/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Pipeline and runtime health: the durable queues, the LLM budget, the
 * notification outbox, the schema version and the in-process worker
 * heartbeats.
 *
 * Every block is guarded by tableExists. The exporter runs against whatever
 * schema the mounted database happens to have — a mid-upgrade or partially
 * restored database must yield fewer series, never a failed scrape.
 */

import { tableExists } from '../../../../shared/sqlite.js';
import { getMigrationStatus } from '../../../storage/migrations/migrate.js';
import { addHeader, emitQuantiles, metric } from '../promText.js';

/**
 * @param {string[]} lines
 * @param {{db: import('better-sqlite3').Database, runtimeSnapshot: object|null}} context
 */
export function collectPipelineHealth(lines, context) {
  const { db, runtimeSnapshot } = context;
  emitRuntimeSnapshotMetrics(lines, runtimeSnapshot);
  emitGeocodingHealthMetrics(lines, runtimeSnapshot);
  emitSchemaMetrics(lines, db);
  emitQueueMetrics(lines, db);
  emitWorkerMetrics(lines, runtimeSnapshot);
}

function emitRuntimeSnapshotMetrics(lines, runtimeSnapshot) {
  const ageSeconds = runtimeSnapshot
    ? Math.max(0, (Date.now() - runtimeSnapshot.receivedAt) / 1000)
    : Number.POSITIVE_INFINITY;
  addHeader(lines, 'fredy_runtime_snapshot_up', 'gauge', 'Whether runtime state is arriving from the main process.');
  metric(lines, 'fredy_runtime_snapshot_up', Number.isFinite(ageSeconds) && ageSeconds <= 30 ? 1 : 0);
  if (Number.isFinite(ageSeconds)) {
    addHeader(lines, 'fredy_runtime_snapshot_age_seconds', 'gauge', 'Age of the main-process runtime snapshot.');
    metric(lines, 'fredy_runtime_snapshot_age_seconds', ageSeconds);
  }
}

/*
 * Geocoding health: pipeline runs abort (nothing stored) while the geocoder
 * is unavailable, so this gauge is the primary alert signal for "Fredy is
 * running but not ingesting". Only meaningful in-process (single-container
 * mode); the standalone exporter CLI reports its own process state.
 */
function emitGeocodingHealthMetrics(lines, runtimeSnapshot) {
  const health = runtimeSnapshot?.geocoding;
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

function emitSchemaMetrics(lines, db) {
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

function emitQueueMetrics(lines, db) {
  if (tableExists(db, 'parsing_queue')) {
    const queueRows = db
      .prepare(
        // Age is measured from when the item entered the queue, not from
        // discovered_at. discovered_at is when the provider first showed the
        // listing, so re-queueing anything older than the alert threshold —
        // which a restart-driven reconcile does routinely — made the queue look
        // stalled the instant it started working. The alert on this metric
        // claims an item is "stuck in processing", so it has to measure queue
        // residency.
        `SELECT status, stage, COUNT(*) AS count, MIN(created_at) AS oldest
         FROM parsing_queue GROUP BY status, stage`,
      )
      .all();
    addHeader(lines, 'fredy_parsing_queue_items', 'gauge', 'Durable parsing queue items by status and stage.');
    for (const row of queueRows) {
      metric(lines, 'fredy_parsing_queue_items', row.count, {
        status: row.status,
        stage: row.stage,
      });
    }
    addHeader(lines, 'fredy_parsing_queue_oldest_age_seconds', 'gauge', 'Age of the oldest unfinished queue item.');
    const oldest = queueRows
      .filter((row) => !['completed', 'duplicate', 'dead', 'cancelled'].includes(row.status))
      .map((row) => row.oldest)
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    metric(lines, 'fredy_parsing_queue_oldest_age_seconds', oldest ? Math.max(0, (Date.now() - oldest) / 1000) : 0);
  }

  emitDurableQueueMetrics(lines, db, {
    table: 'detail_fetch_queue',
    metricName: 'fredy_detail_fetch_queue_items',
    ageMetricName: 'fredy_detail_fetch_queue_oldest_age_seconds',
    description: 'Detail-fetch queue items by status.',
    terminalStatuses: ['completed', 'inactive', 'cancelled'],
  });

  emitDurableQueueMetrics(lines, db, {
    table: 'rating_queue',
    metricName: 'fredy_rating_queue_items',
    ageMetricName: 'fredy_rating_queue_oldest_age_seconds',
    description: 'Market-rating queue items by status.',
    terminalStatuses: ['completed', 'cancelled'],
  });

  if (tableExists(db, 'listing_images')) {
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

  if (tableExists(db, 'listing_extractions')) {
    const extraction = db
      .prepare(
        `SELECT COUNT(*) AS count,
                SUM(CASE WHEN llm_json IS NOT NULL THEN 1 ELSE 0 END) AS completed
         FROM listing_extractions`,
      )
      .get();
    addHeader(lines, 'fredy_listing_extractions', 'gauge', 'Required LLM extractions by state.');
    metric(lines, 'fredy_listing_extractions', extraction.completed ?? 0, { state: 'complete' });
    metric(lines, 'fredy_listing_extractions', extraction.count - (extraction.completed ?? 0), { state: 'pending' });
  }

  if (tableExists(db, 'llm_call_audit')) {
    const audit = db.prepare(`SELECT operation, outcome, COUNT(*) AS count FROM llm_call_audit GROUP BY 1, 2`).all();
    addHeader(lines, 'fredy_llm_calls', 'counter', 'Audited LLM HTTP calls by operation and outcome.');
    for (const row of audit) {
      metric(lines, 'fredy_llm_calls', row.count, { operation: row.operation, outcome: row.outcome });
    }
  }

  if (tableExists(db, 'notification_deliveries')) emitNotificationMetrics(lines, db);
  if (tableExists(db, 'llm_budget_usage')) emitLlmBudgetMetrics(lines, db);

  if (tableExists(db, 'processing_attempts')) {
    const attempts = db.prepare(`SELECT status, COUNT(*) AS count FROM processing_attempts GROUP BY status`).all();
    addHeader(lines, 'fredy_processing_attempts', 'gauge', 'Parser processing attempts by terminal state.');
    for (const row of attempts) metric(lines, 'fredy_processing_attempts', row.count, { status: row.status });
  }

  if (tableExists(db, 'pipeline_audit_events')) {
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

function emitNotificationMetrics(lines, db) {
  const deliveries = db.prepare(`SELECT status, COUNT(*) AS count FROM notification_deliveries GROUP BY status`).all();
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

function emitLlmBudgetMetrics(lines, db) {
  const day = new Date();
  const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const usage = db.prepare(`SELECT count FROM llm_budget_usage WHERE day = ?`).get(dayStart);
  addHeader(lines, 'fredy_llm_budget_used_requests', 'gauge', 'LLM requests consumed today from the daily budget.');
  metric(lines, 'fredy_llm_budget_used_requests', usage?.count ?? 0);
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

function emitDurableQueueMetrics(lines, db, options) {
  if (!tableExists(db, options.table)) return;
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

function emitWorkerMetrics(lines, runtimeSnapshot) {
  const health = runtimeSnapshot?.workers;
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
