/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import logger from '../logger.js';
import { backoffMs, delay } from '../../shared/async.js';
import { env } from '../../shared/env.js';
import { jsonObject, toJson } from '../../shared/json.js';
import { tableExists } from '../../shared/sqlite.js';
import { heartbeatWorker, recordWorkerLoopRestart, registerWorker, superviseWorkerItem } from './workerSupervisor.js';
import { CODE_SET, OUTCOME_SET, STATUS_SET, classifyWorkFailure } from './workOutcome.js';
import { recordProviderSignal } from '../jobs/providerHealth.js';

export const CLAIMABLE_STATUSES = Object.freeze(['pending', 'retry', 'deferred', 'processing']);

export const CLAIMABLE_SQL = `(${CLAIMABLE_STATUSES.map((status) => `'${status}'`).join(', ')})`;

const DEFAULT_LEASE_MS = 10 * 60 * 1000;

// For work that something else re-enqueues on a schedule: rating after every
// retrain, liveness every maintenance pass, maintenance and market-model on a
// fresh key each interval. Retrying inside the item only duplicates the
// recovery the schedule already provides.
export const SINGLE_ATTEMPT = 1;

const BULK_PAYLOAD_KEYS = ['discovery', 'capture'];

const handlers = new Map();

export function registerHandler(kind, spec) {
  if (typeof spec.maxAttempts !== 'function') {
    throw new TypeError(`Work kind '${kind}' must declare maxAttempts(); unbounded retry is never the answer.`);
  }
  handlers.set(kind, { kind, order: 'oldest', enabled: () => true, ...spec });
}

export function enqueueWork(kind, key, payload, { mode = 'reset', fingerprintKey = null, merge = null } = {}) {
  return SqliteConnection.withTransaction((db) => {
    const now = Date.now();
    const existing = selectRow(db, kind, key);
    if (!existing) {
      db.prepare(
        `INSERT INTO pipeline_work (kind, key, payload_json, status, created_at, updated_at)
         VALUES (@kind, @key, @payload, 'pending', @now, @now)`,
      ).run({ kind, key, payload: toJson(payload) ?? '{}', now });
      return { key, changed: true, status: 'pending' };
    }

    const stored = jsonObject(existing.payload_json);
    if (mode === 'ignore') return { key, changed: false, status: existing.status };
    const unchanged =
      mode === 'fingerprint' &&
      fingerprintKey != null &&
      payload[fingerprintKey] != null &&
      stored[fingerprintKey] === payload[fingerprintKey];
    if (unchanged) {
      db.prepare('UPDATE pipeline_work SET updated_at = ? WHERE kind = ? AND key = ?').run(now, kind, key);
      return { key, changed: false, status: existing.status };
    }

    const merged = merge ? merge(stored, payload) : { ...stored, ...payload };
    db.prepare(
      `UPDATE pipeline_work
       SET payload_json = @payload, status = 'pending', attempt_count = 0, lease_until = NULL,
           next_attempt_at = 0, last_error = NULL, updated_at = @now
       WHERE kind = @kind AND key = @key`,
    ).run({ kind, key, payload: toJson(merged) ?? '{}', now });
    return { key, changed: true, status: 'pending' };
  });
}

export function claimWork(kind, { now = Date.now(), leaseMs = DEFAULT_LEASE_MS } = {}) {
  const spec = handlers.get(kind);
  const filter = spec?.claimFilter?.() ?? null;
  const newestFirst = spec?.order === 'newest';
  return SqliteConnection.withTransaction((db) => {
    const row = db
      .prepare(
        `SELECT * FROM pipeline_work w
         WHERE w.kind = @kind AND w.status IN ${CLAIMABLE_SQL}
           AND w.next_attempt_at <= @now
           AND (w.lease_until IS NULL OR w.lease_until < @now)
           ${filter?.sql ?? ''}
         ORDER BY w.created_at ${newestFirst ? 'DESC' : 'ASC'}
         LIMIT 1`,
      )
      .get({ kind, now, ...(filter?.params ?? {}) });
    if (!row) return null;
    return takeClaim(db, kind, row, { now, leaseMs });
  });
}

// One row moves from claimable to processing. Reclaiming an expired lease costs
// an attempt and leaves an audit trail; a row someone else took first returns
// null so the caller simply looks again.
function takeClaim(db, kind, row, { now, leaseMs }) {
  const reclaimed = row.status === 'processing';
  const claimed = db
    .prepare(
      `UPDATE pipeline_work
       SET status = 'processing', lease_until = @leaseUntil, updated_at = @now,
           attempt_count = attempt_count + @reclaimed, last_error = @lastError
       WHERE kind = @kind AND key = @key AND status IN ${CLAIMABLE_SQL}
         AND (lease_until IS NULL OR lease_until < @now)`,
    )
    .run({
      kind,
      key: row.key,
      now,
      leaseUntil: now + leaseMs,
      reclaimed: reclaimed ? 1 : 0,
      lastError: reclaimed ? 'Reclaimed after an expired lease' : null,
    });
  if (!claimed.changes) return null;
  if (reclaimed) writeAudit(db, kind, row.key, { action: 'reclaimed', reason: 'Previous lease expired' });
  return hydrate(selectRow(db, kind, row.key));
}

export function retryWork(
  kind,
  key,
  error,
  { delayMs = null, maxFailures = null, counter = null, stage = null, classification = null, code = null } = {},
) {
  return SqliteConnection.withTransaction((db) => {
    const row = selectRow(db, kind, key);
    if (!row) return { status: 'unchanged', attempts: 0 };
    const payload = jsonObject(row.payload_json);
    const attempts = counter ? Number(payload[counter] || 0) + 1 : Number(row.attempt_count || 0) + 1;
    if (counter) payload[counter] = attempts;

    if (maxFailures != null && attempts >= maxFailures) {
      terminate(db, kind, key, 'dead', {
        lastError: message(error),
        payload,
        stage,
        action: 'failed',
        outcome: 'failed',
        code: code ?? 'attempts_exhausted',
        note: `Abandoned after ${attempts} attempts.`,
        classification: { ...classification, attempts },
      });
      return { status: 'dead', attempts };
    }

    const rescheduled = reschedule(db, kind, key, {
      payload,
      countAttempt: true,
      nextAttemptAt: Date.now() + (delayMs ?? backoffMs(row.attempt_count)),
      lastError: message(error),
      code,
      audit: { stage, action: 'retry', reason: error, payload: classification },
    });
    return { status: rescheduled ? 'retry' : 'unchanged', attempts };
  });
}

export function deferWork(kind, key, reason, untilMs, { counter = null, code = 'transient' } = {}) {
  return SqliteConnection.withTransaction((db) => {
    const row = selectRow(db, kind, key);
    if (!row) return 'unchanged';
    const parks = Number(row.defer_count || 0) + 1;
    const age = Date.now() - Number(row.created_at || Date.now());
    if (parks > env('FREDY_WORK_MAX_DEFERRALS') || age > env('FREDY_WORK_MAX_PARK_MS')) {
      terminate(db, kind, key, 'dead', {
        outcome: 'abandoned',
        code: 'parked_out',
        note: `Gave up after ${parks} deferrals waiting: ${String(reason).slice(0, 400)}`,
        action: 'failed',
      });
      return 'dead';
    }
    const payload = jsonObject(row.payload_json);
    if (counter) payload[counter] = Number(payload[counter] || 0) + 1;
    reschedule(db, kind, key, {
      payload,
      countAttempt: false,
      park: true,
      status: 'deferred',
      nextAttemptAt: Math.max(Number(untilMs) || 0, Date.now() + 1000),
      lastError: null,
      code,
      note: String(reason),
      audit: { action: 'deferred', reason },
    });
    return 'deferred';
  });
}

export function applyOutcome(kind, key, decision) {
  const result = SqliteConnection.withTransaction((db) => {
    const row = selectRow(db, kind, key);
    if (!row) return 'unchanged';
    switch (decision.disposition) {
      case 'settle':
      case 'cancel': {
        const terminal = decision.disposition === 'cancel' ? 'cancelled' : 'done';
        return terminate(db, kind, key, terminal, {
          outcome: decision.outcome ?? (terminal === 'cancelled' ? 'cancelled' : 'completed'),
          code: decision.code,
          note: decision.note,
          patch: decision.patch,
          action: decision.outcome ?? terminal,
          classification: decision.classification,
          guardCancelled: decision.disposition !== 'cancel',
        })
          ? terminal
          : 'unchanged';
      }
      case 'abandon':
        return terminate(db, kind, key, 'dead', {
          outcome: decision.outcome ?? 'abandoned',
          code: decision.code,
          note: decision.note,
          lastError: decision.error ? message(decision.error) : null,
          action: 'failed',
          classification: decision.classification,
        })
          ? 'dead'
          : 'unchanged';
      default:
        return null;
    }
  });
  if (result != null) return result;
  if (decision.disposition === 'park') {
    return deferWork(kind, key, decision.note ?? decision.code, decision.untilMs ?? Date.now(), {
      counter: decision.counter,
      code: decision.code,
    });
  }
  return retryWork(kind, key, decision.error ?? decision.note ?? decision.code, {
    delayMs: decision.delayMs,
    counter: decision.counter,
    classification: decision.classification,
    code: decision.code,
    maxFailures: maxAttemptsFor(kind),
  }).status;
}

function maxAttemptsFor(kind) {
  const spec = handlers.get(kind);
  return spec?.maxAttempts?.() ?? spec?.maxFailures?.() ?? null;
}

export function failWork(kind, item, error) {
  const decision = classifyWorkFailure(handlers.get(kind), item, error);
  if (decision.providerSignal) recordProviderSignal(decision.providerSignal);
  const status = applyOutcome(kind, item.key, decision);
  return { status, severity: decision.severity, code: decision.code, note: decision.note };
}

function reschedule(
  db,
  kind,
  key,
  { payload, countAttempt, nextAttemptAt, lastError, audit, status = 'retry', code = null, note = null, park = false },
) {
  const changed = db
    .prepare(
      `UPDATE pipeline_work
       SET status = @status, lease_until = NULL, attempt_count = attempt_count + @increment,
           defer_count = defer_count + @parked,
           next_attempt_at = @nextAttemptAt, last_error = @lastError,
           outcome_code = @code, outcome_note = @note,
           payload_json = @payload, updated_at = @now
       WHERE kind = @kind AND key = @key AND status IN ${CLAIMABLE_SQL}`,
    )
    .run({
      kind,
      key,
      status,
      now: Date.now(),
      increment: countAttempt ? 1 : 0,
      parked: park ? 1 : 0,
      nextAttemptAt,
      lastError,
      code,
      note: note == null ? null : String(note).slice(0, 2000),
      payload: toJson(payload) ?? '{}',
    });
  if (changed.changes) writeAudit(db, kind, key, audit);
  return changed.changes > 0;
}

export function completeWork(
  kind,
  key,
  { status = 'completed', reason = null, patch = null, action = null, code = null } = {},
) {
  const lifecycle = status === 'cancelled' ? 'cancelled' : 'done';
  return SqliteConnection.withTransaction((db) =>
    terminate(db, kind, key, lifecycle, {
      outcome: status,
      code,
      note: reason,
      patch,
      action: action ?? status,
      guardCancelled: status !== 'cancelled',
    }),
  );
}

export function cancelWork(
  kind,
  key,
  reason,
  { action = 'cancelled', classification = null, code = null, outcome = 'cancelled' } = {},
) {
  SqliteConnection.withTransaction((db) => {
    terminate(db, kind, key, 'cancelled', { outcome, code, note: message(reason), action, classification });
  });
}

export function cancelWorkForListing(listingId, reason = 'Listing filtered') {
  if (!listingId) return;
  SqliteConnection.withTransaction((db) => {
    const rows = db
      .prepare(
        `SELECT kind, key FROM pipeline_work
         WHERE status IN ${CLAIMABLE_SQL}
           AND (
             json_extract(payload_json, '$.listingId') = @listingId
             OR (kind = 'detail' AND key IN (
                   SELECT detail_queue_id FROM listing_sources
                   WHERE listing_id = @listingId AND detail_queue_id IS NOT NULL))
             OR (kind = 'parse' AND key IN (
                   SELECT parsing_queue_id FROM listing_sources
                   WHERE listing_id = @listingId AND parsing_queue_id IS NOT NULL))
           )`,
      )
      .all({ listingId });
    for (const row of rows) {
      terminate(db, row.kind, row.key, 'cancelled', {
        outcome: 'cancelled',
        code: 'listing_hidden',
        note: String(reason),
        action: 'cancelled',
      });
    }
  });
}

export function claimWorkBatch(kind, { limit, groupBy, now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
  const spec = handlers.get(kind);
  const filter = spec?.claimFilter?.() ?? null;
  return SqliteConnection.withTransaction((db) => {
    const due = db
      .prepare(
        `SELECT * FROM pipeline_work w
         WHERE w.kind = @kind AND w.status IN ${CLAIMABLE_SQL}
           AND w.next_attempt_at <= @now
           AND (w.lease_until IS NULL OR w.lease_until < @now)
           ${filter?.sql ?? ''}
         ORDER BY w.created_at ASC
         LIMIT @limit`,
      )
      .all({ kind, now, limit, ...(filter?.params ?? {}) });
    if (!due.length) return [];

    const groupOf = (row) => jsonObject(row.payload_json)[groupBy] ?? null;
    const wanted = groupOf(due[0]);
    const batch = due.filter((row) => groupOf(row) === wanted);

    const claimed = [];
    for (const row of batch) {
      const item = takeClaim(db, kind, row, { now, leaseMs });
      if (item) claimed.push(item);
    }
    return claimed;
  });
}

function terminate(
  db,
  kind,
  key,
  status,
  {
    lastError = null,
    patch,
    payload,
    action,
    classification,
    guardCancelled = true,
    outcome = null,
    code = null,
    note = null,
  },
) {
  if (!STATUS_SET.has(status)) {
    throw new TypeError(`'${status}' is not a work lifecycle status; the domain answer belongs in \`outcome\`.`);
  }
  if (outcome != null && !OUTCOME_SET.has(outcome)) {
    throw new TypeError(`'${outcome}' is not a work outcome. Add it to WORK_OUTCOMES deliberately.`);
  }
  if (code != null && !CODE_SET.has(code)) {
    throw new TypeError(`'${code}' is not an outcome code. Add it to OUTCOME_CODES deliberately.`);
  }
  const row = selectRow(db, kind, key);
  if (!row) return false;
  const merged = { ...(payload ?? jsonObject(row.payload_json)), ...(patch ?? {}), completedAt: Date.now() };
  for (const bulk of BULK_PAYLOAD_KEYS) delete merged[bulk];
  const changed = db
    .prepare(
      `UPDATE pipeline_work
       SET status = @status, lease_until = NULL, last_error = @lastError,
           outcome = @outcome, outcome_code = @code, outcome_note = @note,
           payload_json = @payload, updated_at = @now
       WHERE kind = @kind AND key = @key ${guardCancelled ? "AND status != 'cancelled'" : ''}`,
    )
    .run({
      kind,
      key,
      status,
      lastError: lastError == null ? null : String(lastError).slice(0, 2000),
      outcome,
      code,
      note: note == null ? null : String(note).slice(0, 2000),
      payload: toJson(merged) ?? '{}',
      now: Date.now(),
    });
  if (changed.changes && action) {
    writeAudit(db, kind, key, { action, reason: note ?? lastError, payload: classification });
  }
  return changed.changes > 0;
}

export function auditWork(kind, key, event, db = null) {
  if (db != null && typeof db.prepare !== 'function') {
    throw new TypeError('auditWork(kind, key, event, db): db must be a better-sqlite3 Database.');
  }
  if (db) {
    writeAudit(db, kind, key, event);
    return;
  }
  SqliteConnection.withTransaction((tx) => writeAudit(tx, kind, key, event));
}

function writeAudit(db, kind, key, { stage = null, action, reason = null, payload = null }) {
  if (!tableExists(db, 'pipeline_audit_events')) return;
  db.prepare(
    `INSERT INTO pipeline_audit_events (
       source_id, listing_id, queue_id, stage, action, reason, payload_json, created_at
     ) VALUES (
       NULL,
       COALESCE(
         (SELECT json_extract(payload_json, '$.listingId') FROM pipeline_work WHERE kind = ? AND key = ?),
         (SELECT listing_id FROM listing_sources
          WHERE (detail_queue_id = ? OR parsing_queue_id = ?) AND listing_id IS NOT NULL LIMIT 1)
       ),
       ?, ?, ?, ?, ?, ?
     )`,
  ).run(
    kind,
    key,
    key,
    key,
    key,
    stage ?? kind,
    action,
    reason == null ? null : String(reason?.message || reason).slice(0, 2000) || null,
    toJson(payload),
    Date.now(),
  );
}

export function getWork(kind, key) {
  return hydrate(selectRow(SqliteConnection.getConnection(), kind, key));
}

export function dueWork(kind, now = Date.now()) {
  return SqliteConnection.query(
    `SELECT * FROM pipeline_work
     WHERE kind = @kind AND status IN ${CLAIMABLE_SQL} AND next_attempt_at <= @now
     ORDER BY created_at ASC`,
    { kind, now },
  ).map(hydrate);
}

export function nextDueAt(kind) {
  return (
    SqliteConnection.getConnection()
      .prepare(
        `SELECT MIN(next_attempt_at) AS next_at FROM pipeline_work
         WHERE kind = @kind AND status IN ${CLAIMABLE_SQL}`,
      )
      .get({ kind })?.next_at ?? null
  );
}

// Returns work that settled on a resource which has since arrived — a rating
// parked as 'waiting_model' once a model exists, for instance. Lives here so a
// caller never has to hand-write a lifecycle transition.
export function requeueByOutcome(kind, outcome, db = null) {
  if (!OUTCOME_SET.has(outcome)) {
    throw new TypeError(`'${outcome}' is not a work outcome. Add it to WORK_OUTCOMES deliberately.`);
  }
  const run = (connection) => {
    if (!tableExists(connection, 'pipeline_work')) return 0;
    return connection
      .prepare(
        `UPDATE pipeline_work
         SET status = 'pending', attempt_count = 0, lease_until = NULL,
             next_attempt_at = 0, last_error = NULL, updated_at = @now
         WHERE kind = @kind AND outcome = @outcome`,
      )
      .run({ kind, outcome, now: Date.now() }).changes;
  };
  return db ? run(db) : SqliteConnection.withTransaction(run);
}

export function patchWorkPayload(kind, key, patch) {
  SqliteConnection.withTransaction((db) => {
    const row = selectRow(db, kind, key);
    if (!row) return;
    db.prepare('UPDATE pipeline_work SET payload_json = ?, updated_at = ? WHERE kind = ? AND key = ?').run(
      toJson({ ...jsonObject(row.payload_json), ...patch }) ?? '{}',
      Date.now(),
      kind,
      key,
    );
  });
}

function selectRow(db, kind, key) {
  return db.prepare('SELECT * FROM pipeline_work WHERE kind = ? AND key = ?').get(kind, key) ?? null;
}

function hydrate(row) {
  if (!row) return null;
  return { ...row, payload: jsonObject(row.payload_json) };
}

function message(error) {
  return String(error?.message || error).slice(0, 2000);
}

export function startWorker(kind) {
  const spec = handlers.get(kind);
  if (!spec) throw new Error(`No handler registered for work kind '${kind}'`);
  if (!spec.enabled()) {
    logger.info(`${spec.name} worker is disabled.`);
    return null;
  }
  registerWorker(spec.name, { maxOperationMs: spec.timeoutMs() });
  void superviseLoop(spec);
  logger.info(spec.startedMessage || `Continuous ${spec.name} worker started.`);
  return spec.name;
}

async function superviseLoop(spec) {
  while (true) {
    try {
      await drain(spec);
    } catch (error) {
      recordWorkerLoopRestart(spec.name, error);
      logger.event('worker_loop_failure', 'error', `${spec.name} worker loop stopped unexpectedly; restarting.`, error);
      await delay(env('FREDY_WORKER_RESTART_DELAY_MS'));
    }
  }
}

function batchItem(items) {
  if (!items.length) return null;
  return { key: items[0].key, payload: items[0].payload, items };
}

async function drain(spec) {
  while (true) {
    heartbeatWorker(spec.name);
    let item = null;
    try {
      item = spec.batch
        ? batchItem(claimWorkBatch(spec.kind, { ...spec.batch(), leaseMs: spec.timeoutMs() + 60_000 }))
        : claimWork(spec.kind, { leaseMs: spec.timeoutMs() + 60_000 });
    } catch (error) {
      logger.event('worker_queue_failure', 'error', `${spec.name} queue claim failed; retrying.`, error);
      await delay(env('FREDY_WORK_IDLE_POLL_MS'));
      continue;
    }
    if (!item) {
      await delay(env('FREDY_WORK_IDLE_POLL_MS'));
      continue;
    }

    try {
      await superviseWorkerItem(spec.name, item.key, (signal) => spec.handler(item, { signal }), {
        timeoutMs: spec.timeoutMs(),
      });
    } catch (error) {
      try {
        const outcome = (item.items ?? [item]).map((member) => failWork(spec.kind, member, error)).pop();
        if (outcome.status === 'dead') logger.error(`Abandoned ${spec.kind} item '${item.key}'.`, error);
        else if (outcome.severity === 'error') logger.error(`${spec.name} item '${item.key}' failed.`, error);
        else if (outcome.severity === 'warn') logger.warn(`${spec.name} item '${item.key}' failed.`, error);
        else logger.info(`${spec.name} '${item.key}': ${outcome.code}${outcome.note ? ` — ${outcome.note}` : ''}.`);
      } catch (recoveryError) {
        logger.event(
          'worker_recovery_failure',
          'error',
          `${spec.name} worker failed to record a queue failure; continuing.`,
          recoveryError,
        );
        await delay(env('FREDY_WORK_IDLE_POLL_MS'));
      }
    }
  }
}
