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
  emitServiceContractMetrics(lines, db, runtimeSnapshot);
  emitRuntimeSnapshotMetrics(lines, runtimeSnapshot);
  emitGeocodingHealthMetrics(lines, runtimeSnapshot);
  emitSchemaMetrics(lines, db);
  emitQueueMetrics(lines, db);
  emitWorkerMetrics(lines, runtimeSnapshot);
  emitProviderMetrics(lines, runtimeSnapshot);
}

const SERVICE = 'fredy';
const STALE_JOB_SECONDS = 7200;
const LIVE_PIPELINE_SECONDS = 7200;
const DETAIL_QUEUE_SECONDS = 86400;
const NOTIFICATION_SECONDS = 1800;
const MODEL_SECONDS = 108000;

function emitServiceContractMetrics(lines, db, runtimeSnapshot) {
  addHeader(
    lines,
    'service_check_up',
    'gauge',
    'Standard operational checks exposed by services (1 healthy, 0 failed).',
  );
  addHeader(
    lines,
    'service_events_total',
    'counter',
    'Standard low-cardinality operational events since process start.',
  );

  const check = (name, up, severity = 'critical') => {
    metric(lines, 'service_check_up', up ? 1 : 0, { service: SERVICE, check: name, severity });
  };

  const runtimeAge = runtimeSnapshot ? (Date.now() - runtimeSnapshot.receivedAt) / 1000 : Infinity;
  check('metrics_exporter', true);
  check('runtime_snapshot', runtimeAge <= 30);
  check('worker_health', runtimeSnapshot?.workers?.healthy === true);
  check('scheduled_job_freshness', jobsAreFresh(db));
  check('live_pipeline_age', queueAgeSeconds(db, 'parse') <= LIVE_PIPELINE_SECONDS);
  check('detail_fetch_queue_age', queueAgeSeconds(db, 'detail') <= DETAIL_QUEUE_SECONDS);
  check('llm_failure_rate', llmCallsAreHealthy(db));
  check('notification_delivery', notificationAgeSeconds(db) <= NOTIFICATION_SECONDS);
  check('geocoder_availability', runtimeSnapshot?.geocoding?.healthy === true);
  check('market_model_freshness', modelAgeSeconds(db) <= MODEL_SECONDS);

  for (const event of runtimeSnapshot?.events || []) {
    metric(lines, 'service_events_total', event.count, {
      service: SERVICE,
      event: event.event,
      severity: event.severity,
    });
  }
}

function jobsAreFresh(db) {
  if (!tableExists(db, 'jobs')) return false;
  const cutoff = Date.now() - STALE_JOB_SECONDS * 1000;
  const stale = db
    .prepare(`SELECT count(*) AS count FROM jobs WHERE enabled = 1 AND coalesce(last_run_at, 0) < ?`)
    .get(cutoff)?.count;
  return stale === 0;
}

function queueAgeSeconds(db, kind) {
  if (!tableExists(db, 'pipeline_work')) return Infinity;
  const oldest = db
    .prepare(
      `SELECT min(created_at) AS created_at FROM pipeline_work
       WHERE kind = ? AND status IN ('pending', 'retry', 'processing')`,
    )
    .get(kind)?.created_at;
  return oldest ? Math.max(0, (Date.now() - oldest) / 1000) : 0;
}

function llmCallsAreHealthy(db) {
  if (!tableExists(db, 'llm_call_audit')) return false;
  const row = db
    .prepare(
      `SELECT count(*) AS total,
              sum(CASE WHEN outcome NOT IN ('success', 'aborted') THEN 1 ELSE 0 END) AS failures
       FROM llm_call_audit WHERE started_at >= ?`,
    )
    .get(Date.now() - 60 * 60 * 1000);
  return row.total <= 20 || (row.failures || 0) / row.total <= 1 / 3;
}

function notificationAgeSeconds(db) {
  if (!tableExists(db, 'pipeline_work')) return Infinity;
  const oldest = db
    .prepare(
      `SELECT min(created_at) AS created_at FROM pipeline_work
       WHERE kind = 'notify' AND status IN ('pending', 'retry', 'processing')`,
    )
    .get()?.created_at;
  return oldest ? Math.max(0, (Date.now() - oldest) / 1000) : 0;
}

function modelAgeSeconds(db) {
  if (!tableExists(db, 'homeserver_model_runs')) return Infinity;
  const row = db
    .prepare(
      `SELECT min(created_at) AS created_at, count(*) AS families
       FROM (
         SELECT model_family, max(created_at) AS created_at
         FROM homeserver_model_runs
         GROUP BY model_family
       )`,
    )
    .get();
  return row?.families >= 2 && row.created_at ? Math.max(0, (Date.now() - row.created_at) / 1000) : Infinity;
}

/*
 * Per-provider discovery freshness. Every other signal here stays green while a
 * single portal is blocked — the queues drain, the workers beat, the schema is
 * current — so the age of a provider's last successful discovery is the only
 * series that distinguishes "nothing new to find" from "this portal has stopped
 * answering us". Alert on it.
 */
function emitProviderMetrics(lines, runtimeSnapshot) {
  const providers = runtimeSnapshot?.providers;
  if (!providers?.length) return;
  addHeader(
    lines,
    'fredy_provider_last_success_age_seconds',
    'gauge',
    'Seconds since a provider last returned discovery cards.',
  );
  addHeader(lines, 'fredy_provider_paused_seconds', 'gauge', 'Seconds a provider stays paused by the breaker.');
  addHeader(lines, 'fredy_provider_consecutive_failures', 'gauge', 'Consecutive empty or failed discovery runs.');
  for (const provider of providers) {
    const labels = { provider: provider.provider };
    if (provider.lastSuccessAgeMs != null) {
      metric(lines, 'fredy_provider_last_success_age_seconds', provider.lastSuccessAgeMs / 1000, labels);
    }
    metric(lines, 'fredy_provider_paused_seconds', provider.pausedForMs / 1000, labels);
    metric(lines, 'fredy_provider_consecutive_failures', provider.failures, labels);
  }
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
  if (tableExists(db, 'pipeline_work')) {
    const work = db
      .prepare(
        `SELECT kind, status, COALESCE(json_extract(payload_json, '$.stage'), '') AS stage,
                COUNT(*) AS count, MIN(created_at) AS oldest
         FROM pipeline_work
         GROUP BY kind, status, stage`,
      )
      .all();
    addHeader(lines, 'fredy_pipeline_work_items', 'gauge', 'Durable pipeline work items by kind and status.');
    for (const row of work) {
      metric(lines, 'fredy_pipeline_work_items', row.count, {
        kind: row.kind,
        status: row.status,
        ...(row.stage ? { stage: row.stage } : {}),
      });
    }
    addHeader(
      lines,
      'fredy_pipeline_work_oldest_age_seconds',
      'gauge',
      'Age of the oldest unfinished pipeline item by kind.',
    );
    for (const kind of new Set(work.map((row) => row.kind))) {
      const oldest = work
        .filter((row) => row.kind === kind && ['pending', 'retry', 'processing'].includes(row.status))
        .map((row) => row.oldest)
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
      metric(lines, 'fredy_pipeline_work_oldest_age_seconds', oldest ? Math.max(0, (Date.now() - oldest) / 1000) : 0, {
        kind,
      });
    }
  }

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

  if (tableExists(db, 'pipeline_work')) emitNotificationMetrics(lines, db);
  if (tableExists(db, 'llm_budget_usage')) emitLlmBudgetMetrics(lines, db);

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
  const deliveries = db
    .prepare(`SELECT status, COUNT(*) AS count FROM pipeline_work WHERE kind = 'notify' GROUP BY status`)
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
         MIN(CASE WHEN status IN ('pending', 'retry', 'processing') THEN created_at END) AS oldest_pending,
         MAX(CASE WHEN status = 'sent' THEN updated_at END) AS last_sent
       FROM pipeline_work
       WHERE kind = 'notify'`,
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
      `SELECT updated_at - created_at AS duration_ms
       FROM pipeline_work
       WHERE kind = 'notify' AND status = 'sent' AND created_at >= ?`,
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
