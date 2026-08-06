/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { CLAIMABLE_SQL } from '../../../pipeline/workQueue.js';
import { tableExists } from '../../../../shared/sqlite.js';
import { addHeader, metric } from '../promText.js';

// Only metrics something reads are emitted: the service-contract checks and
// events the ops dashboard queries, plus the two series the Fredy dashboard
// panels are built on. Everything else this collector used to publish had no
// consumer — no panel, no rule — and /health already answers those questions on
// demand.
export function collectPipelineHealth(lines, context) {
  const { db, runtimeSnapshot } = context;
  emitServiceContractMetrics(lines, db, runtimeSnapshot);
  emitProxyMetrics(lines, runtimeSnapshot);
  emitCardFilterAuditMetrics(lines, db);
  emitLlmCallMetrics(lines, db);
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
  check('notification_delivery', queueAgeSeconds(db, 'notify') <= NOTIFICATION_SECONDS);
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

// Immowelt declares requiresProxy, so with no proxy configured it is the one
// provider that cannot run at all. The ops dashboard has queried this series
// since before anything emitted it.
function emitProxyMetrics(lines, runtimeSnapshot) {
  addHeader(lines, 'fredy_proxy_ok', 'gauge', 'Whether an outbound proxy is configured for providers that need one.');
  metric(lines, 'fredy_proxy_ok', runtimeSnapshot?.proxy?.configured ? 1 : 0);
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
       WHERE kind = ? AND status IN ${CLAIMABLE_SQL}`,
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

function emitCardFilterAuditMetrics(lines, db) {
  if (!tableExists(db, 'pipeline_audit_events')) return;
  const rows = db
    .prepare(
      `SELECT COALESCE(reason, '') AS reason, action, COUNT(*) AS count
       FROM pipeline_audit_events
       WHERE stage = 'card_audit'
       GROUP BY reason, action`,
    )
    .all();
  addHeader(
    lines,
    'fredy_card_filter_audit_total',
    'counter',
    'Sampled card refusals graded against the post-extraction verdict, by refusal reason.',
  );
  for (const row of rows) {
    metric(lines, 'fredy_card_filter_audit_total', row.count, {
      reason: row.reason || 'unknown',
      verdict: row.action,
    });
  }
}

function emitLlmCallMetrics(lines, db) {
  if (!tableExists(db, 'llm_call_audit')) return;
  const rows = db.prepare(`SELECT operation, outcome, COUNT(*) AS count FROM llm_call_audit GROUP BY 1, 2`).all();
  addHeader(lines, 'fredy_llm_calls', 'counter', 'Audited LLM HTTP calls by operation and outcome.');
  for (const row of rows) {
    metric(lines, 'fredy_llm_calls', row.count, { operation: row.operation, outcome: row.outcome });
  }
}
