/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { CLAIMABLE_SQL } from '../../../pipeline/workQueue.js';
import { tableExists } from '../../../../shared/sqlite.js';
import { normalizeMarket } from '../../markets.js';
import { addHeader, metric, ratio } from '../promText.js';

// Only metrics something reads are emitted: the service-contract checks and
// events the ops dashboard queries, plus the two series the Fredy dashboard
// panels are built on. Everything else this collector used to publish had no
// consumer — no panel, no rule — and /health already answers those questions on
// demand.
export function collectPipelineHealth(lines, context) {
  const { db, runtimeSnapshot } = context;
  emitServiceContractMetrics(lines, db, runtimeSnapshot);
  emitProxyMetrics(lines, runtimeSnapshot);
  emitProviderHealthMetrics(lines, db);
  emitCardFilterAuditMetrics(lines, db);
  emitLlmCallMetrics(lines, db);
}

const SERVICE = 'fredy';
const STALE_JOB_SECONDS = 7200;
const LIVE_PIPELINE_SECONDS = 7200;
const DETAIL_QUEUE_SECONDS = 86400;
const NOTIFICATION_SECONDS = 1800;
const MODEL_SECONDS = 108000;

// Every check here used to ask whether a queue was draining. That is the one
// question this pipeline's failures cannot be caught by, because the way work
// fails is that it leaves the queue: `dead` and `cancelled` are not claimable,
// so the queue drains faster the worse delivery gets. The checks below pair the
// age of what is still claimable with the outcome of what has already left.
const TERMINAL_WINDOW_MS = 6 * 60 * 60 * 1000;
const TERMINAL_FAILURE_RATIO = 1 / 3;
// A provider that has not succeeded for longer than the breaker's own ceiling
// is not backing off any more; it is simply not working.
const PROVIDER_DEAD_SECONDS = 21600;

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
  check('scheduled_job_freshness', jobsAreFresh(db), 'warning');
  check('live_pipeline_age', queueIsHealthy(db, 'parse', LIVE_PIPELINE_SECONDS), 'warning');
  check('detail_fetch_queue_age', queueIsHealthy(db, 'detail', DETAIL_QUEUE_SECONDS), 'warning');
  check('llm_failure_rate', llmCallsAreHealthy(db), 'warning');
  check('notification_delivery', deliveryIsHealthy(db));
  // Warning, not critical: providers go dark whenever the outbound proxy does,
  // and the proxy is an exit node that is not always up. This belongs on the
  // dashboard, not in a notification at 03:00.
  check('provider_discovery', staleProviders(db).length === 0, 'warning');
  check('geocoder_availability', runtimeSnapshot?.geocoding?.healthy === true, 'warning');
  check('market_model_freshness', modelAgeSeconds(db) <= MODEL_SECONDS, 'warning');

  for (const event of runtimeSnapshot?.events || []) {
    metric(lines, 'service_events_total', event.count, {
      service: SERVICE,
      event: event.event,
      severity: event.severity,
    });
  }
}

// Immowelt declares requiresProxy, so without a reachable proxy it is the one
// provider that cannot run at all. The ops dashboard reads this series.
function emitProxyMetrics(lines, runtimeSnapshot) {
  addHeader(lines, 'fredy_proxy_ok', 'gauge', 'Whether the configured outbound proxy is reachable and usable.');
  metric(lines, 'fredy_proxy_ok', runtimeSnapshot?.proxy?.usable ? 1 : 0);
}

// The breaker table is the only place that knows a provider stopped working,
// and until now it was read by nothing outside the scheduler. Two series are
// enough to answer both operational questions — is this portal producing, and
// is it backing off — so the internal failure score, which is only meaningful
// after decay, stays where it is used.
function emitProviderHealthMetrics(lines, db, now = Date.now()) {
  if (!tableExists(db, 'provider_breaker_state')) return;
  const rows = db.prepare(`SELECT * FROM provider_breaker_state ORDER BY provider, market`).all();
  addHeader(
    lines,
    'fredy_provider_last_success_age_seconds',
    'gauge',
    'Seconds since this provider last returned results for this market.',
  );
  addHeader(lines, 'fredy_provider_paused_seconds', 'gauge', 'Seconds this provider stays paused by the breaker.');
  for (const row of rows) {
    const labels = { provider: row.provider, market: row.market };
    if (row.last_success_at) {
      metric(lines, 'fredy_provider_last_success_age_seconds', (now - Number(row.last_success_at)) / 1000, labels);
    }
    metric(lines, 'fredy_provider_paused_seconds', Math.max(0, (Number(row.open_until || 0) - now) / 1000), labels);
  }
}

// jobs.last_run_at is stamped in the scheduler's finally(), so it advances when
// a provider blows its deadline and when one is skipped for a missing proxy. It
// only ever proved the scheduler ticked. A job is fresh when discovery in its
// market actually returned something.
function jobsAreFresh(db) {
  if (!tableExists(db, 'jobs') || !tableExists(db, 'provider_breaker_state')) return false;
  const cutoff = Date.now() - STALE_JOB_SECONDS * 1000;
  const markets = db
    .prepare(`SELECT DISTINCT city FROM jobs WHERE enabled = 1 AND city IS NOT NULL`)
    .all()
    .map((row) => normalizeMarket(row.city));
  if (!markets.length) return true;
  const fresh = new Set(
    db
      .prepare(`SELECT DISTINCT market FROM provider_breaker_state WHERE coalesce(last_success_at, 0) >= ?`)
      .all(cutoff)
      .map((row) => row.market),
  );
  return markets.every((market) => fresh.has(market));
}

function staleProviders(db, now = Date.now()) {
  if (!tableExists(db, 'provider_breaker_state')) return [];
  return db
    .prepare(`SELECT provider, market FROM provider_breaker_state WHERE coalesce(last_success_at, 0) < ?`)
    .all(now - PROVIDER_DEAD_SECONDS * 1000);
}

// What already left the queue, and how it left. `cancelled` is deliberately not
// counted as failure: filtered and hidden listings are the pipeline working.
function terminalOutcomes(db, kind, since) {
  if (!tableExists(db, 'pipeline_work')) return { done: 0, dead: 0 };
  const row = db
    .prepare(
      `SELECT sum(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
              sum(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
         FROM pipeline_work
        WHERE kind = ? AND status IN ('done', 'dead') AND updated_at >= ?`,
    )
    .get(kind, since);
  return { done: Number(row?.done || 0), dead: Number(row?.dead || 0) };
}

function terminalFailureRatio(db, kind) {
  const { done, dead } = terminalOutcomes(db, kind, Date.now() - TERMINAL_WINDOW_MS);
  return done + dead === 0 ? 0 : ratio(dead, done + dead);
}

function queueIsHealthy(db, kind, maxAgeSeconds) {
  if (queueAgeSeconds(db, kind) > maxAgeSeconds) return false;
  return terminalFailureRatio(db, kind) <= TERMINAL_FAILURE_RATIO;
}

// Queue age alone could never see the failure this check is named for. A
// notification that exhausts its attempts is dead-lettered, `dead` is not
// claimable, and the queue it was measured by therefore drains as delivery gets
// worse: 230 listings were abandoned to a chat the bot was not a member of
// while this check read 1 throughout.
function deliveryIsHealthy(db) {
  if (queueAgeSeconds(db, 'notify') > NOTIFICATION_SECONDS) return false;
  return terminalFailureRatio(db, 'notify') <= TERMINAL_FAILURE_RATIO;
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
      // Oldest current artifact across every family in every market: a city
      // whose model has gone stale is the pipeline's problem, not its own.
      `SELECT min(created_at) AS created_at, count(*) AS families
       FROM (
         SELECT model_family, market, max(created_at) AS created_at
         FROM homeserver_model_runs
         GROUP BY model_family, market
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
