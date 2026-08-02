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

/**
 * The durable work queue. One table, one claim, one retry, one lease.
 *
 * There used to be four of these: detail_fetch_queue, parsing_queue,
 * rating_queue and notification_deliveries, each with its own status,
 * attempt_count, lease_until and next_attempt_at columns, its own claim
 * transaction, and its own copy of the exponential-backoff expression. They
 * differed in exactly two things — the payload, and the function that processes
 * it — so those are the two things a caller supplies here. Everything else,
 * including which failure counts and which does not, is decided once.
 *
 * The lease is what makes crash recovery ordinary rather than a startup ritual.
 * A worker that dies mid-item leaves the row in 'processing' with a lease that
 * expires; the next poller reclaims it and counts the interrupted attempt, so it
 * cannot spin forever. That is why the two startup repair passes are gone: there
 * is nothing left for them to reconcile that the next claim does not.
 */

/** Statuses a poller may take. Everything else is terminal by construction. */
const CLAIMABLE = "('pending', 'retry', 'processing')";

/**
 * Ten minutes. Long enough that a slow provider capture or a queued LLM call
 * keeps its item, short enough that a killed container's work is back in the
 * queue before the next scheduled discovery run produces more of it.
 */
const DEFAULT_LEASE_MS = 10 * 60 * 1000;

/** Payload keys holding bulk evidence, dropped when an item stops being work. */
const BULK_PAYLOAD_KEYS = ['discovery', 'capture'];

/** @type {Map<string, object>} kind → handler registration */
const handlers = new Map();

/**
 * Declare how one kind of work is drained.
 *
 * @param {string} kind row discriminator in pipeline_work
 * @param {object} spec
 * @param {string} spec.name worker name reported by the health endpoint
 * @param {(item: object, ctx: {signal: AbortSignal}) => Promise<unknown>} spec.handler
 * @param {() => number} spec.timeoutMs per-item deadline
 * @param {() => boolean} [spec.enabled] kill switch; a disabled kind never starts
 * @param {() => number} [spec.maxFailures] attempts before an item is abandoned
 * @param {'oldest'|'newest'} [spec.order] which end of the queue to serve first
 * @param {() => ({sql: string, params?: object}|null)} [spec.claimFilter] extra
 *   claim predicate over the aliased row `w`, for work that needs a resource
 * @param {(item: object, error: Error) => boolean} [spec.onError] returns true
 *   when it has already recorded the outcome itself
 * @param {string} [spec.startedMessage]
 */
export function registerHandler(kind, spec) {
  handlers.set(kind, { kind, order: 'oldest', enabled: () => true, ...spec });
}

/**
 * Insert or refresh one work item.
 *
 * PRIMARY KEY (kind, key) is what makes this idempotent, and `mode` is the only
 * thing the four kinds ever disagreed about:
 *
 *   'fingerprint'  reset the item only when the named payload field changed.
 *                  Discovery re-finds the same advert on every run of every job;
 *                  without this a single wg-gesucht URL was re-decided 401 times
 *                  in seven days. The fingerprint is a field the payload already
 *                  carries — a discovery hash, a capture hash — rather than a
 *                  copy of it, so an item whose payload predates this call still
 *                  compares equal instead of being requeued once on upgrade.
 *   'reset'        always make the item claimable again, merging the payload.
 *   'ignore'       leave an existing row alone, whatever state it is in. A
 *                  notification that was already sent must never be re-sent.
 *
 * @param {string} kind
 * @param {string} key
 * @param {object} payload
 * @param {{mode?: 'fingerprint'|'reset'|'ignore', fingerprintKey?: string|null,
 *          merge?: (existing: object, incoming: object) => object}} [options]
 * @returns {{key: string, changed: boolean, status: string}}
 */
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

/**
 * Claim the next item of `kind` and hold it under a lease.
 *
 * Reclaiming is deliberately not a special case: a row still marked 'processing'
 * whose lease has run out is selected by the same query as a fresh one, and the
 * interrupted attempt is counted so a payload that reliably kills its worker
 * runs out of attempts instead of being retried forever.
 *
 * @param {string} kind
 * @param {{now?: number, leaseMs?: number}} [options]
 * @returns {object|null} hydrated item, or null when nothing is claimable
 */
export function claimWork(kind, { now = Date.now(), leaseMs = DEFAULT_LEASE_MS } = {}) {
  const spec = handlers.get(kind);
  const filter = spec?.claimFilter?.() ?? null;
  const newestFirst = spec?.order === 'newest';
  return SqliteConnection.withTransaction((db) => {
    const row = db
      .prepare(
        `SELECT * FROM pipeline_work w
         WHERE w.kind = @kind AND w.status IN ${CLAIMABLE}
           AND w.next_attempt_at <= @now
           AND (w.lease_until IS NULL OR w.lease_until < @now)
           ${filter?.sql ?? ''}
         ORDER BY w.created_at ${newestFirst ? 'DESC' : 'ASC'}
         LIMIT 1`,
      )
      .get({ kind, now, ...(filter?.params ?? {}) });
    if (!row) return null;

    const reclaimed = row.status === 'processing';
    const claimed = db
      .prepare(
        `UPDATE pipeline_work
         SET status = 'processing', lease_until = @leaseUntil, updated_at = @now,
             attempt_count = attempt_count + @reclaimed, last_error = @lastError
         WHERE kind = @kind AND key = @key AND status IN ${CLAIMABLE}
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
  });
}

/**
 * Record a genuine failure and schedule another attempt.
 *
 * This is the only place a failure attempt is counted, and the only place the
 * backoff curve is chosen — from `backoffMs`, so the four queues can no longer
 * disagree about how patient the pipeline is.
 *
 * @param {string} kind
 * @param {string} key
 * @param {Error|string} error
 * @param {{delayMs?: number|null, maxFailures?: number|null, counter?: string|null,
 *          stage?: string|null, classification?: object|null}} [options]
 *   `counter` names a payload counter to bump and to compare against
 *   `maxFailures` instead of the row's own attempt count, which is how an LLM
 *   failure budget stays separate from the item's total attempts.
 * @returns {{status: 'retry'|'dead'|'unchanged', attempts: number}}
 */
export function retryWork(
  kind,
  key,
  error,
  { delayMs = null, maxFailures = null, counter = null, stage = null, classification = null } = {},
) {
  return SqliteConnection.withTransaction((db) => {
    const row = selectRow(db, kind, key);
    if (!row) return { status: 'unchanged', attempts: 0 };
    const payload = jsonObject(row.payload_json);
    const attempts = counter ? Number(payload[counter] || 0) + 1 : Number(row.attempt_count || 0) + 1;
    if (counter) payload[counter] = attempts;

    if (maxFailures != null && attempts >= maxFailures) {
      terminate(db, kind, key, 'dead', {
        reason: message(error),
        payload,
        stage,
        action: 'failed',
        classification: { ...classification, attempts },
      });
      return { status: 'dead', attempts };
    }

    const rescheduled = reschedule(db, kind, key, {
      payload,
      countAttempt: true,
      nextAttemptAt: Date.now() + (delayMs ?? backoffMs(row.attempt_count)),
      lastError: message(error),
      audit: { stage, action: 'retry', reason: error, payload: classification },
    });
    return { status: rescheduled ? 'retry' : 'unchanged', attempts };
  });
}

/**
 * Park an item until a resource is available again.
 *
 * Deferrals are not failures: no attempt counter moves, so a listing can wait
 * days for the LLM budget or the geocoder without burning the attempts it needs
 * for real errors. `counter` exists for the geocode escape hatch, which
 * eventually accepts a listing without coordinates.
 *
 * @param {string} kind
 * @param {string} key
 * @param {string} reason
 * @param {number} untilMs
 * @param {{counter?: string|null}} [options]
 */
export function deferWork(kind, key, reason, untilMs, { counter = null } = {}) {
  SqliteConnection.withTransaction((db) => {
    const row = selectRow(db, kind, key);
    if (!row) return;
    const payload = jsonObject(row.payload_json);
    if (counter) payload[counter] = Number(payload[counter] || 0) + 1;
    reschedule(db, kind, key, {
      payload,
      countAttempt: false,
      // One second of slack: an item that becomes due in the same millisecond it
      // was deferred is claimed again before the resource has moved.
      nextAttemptAt: Math.max(Number(untilMs) || 0, Date.now() + 1000),
      lastError: `Waiting: ${String(reason).slice(0, 1900)}`,
      audit: { action: 'deferred', reason },
    });
  });
}

/**
 * Put a claimed item back into the queue for later. A failure and a deferral
 * differ only in whether the attempt counts and in what they write to
 * last_error; sharing the statement is what keeps them agreeing about the rest —
 * dropping the lease, respecting a cancellation, leaving created_at alone.
 */
function reschedule(db, kind, key, { payload, countAttempt, nextAttemptAt, lastError, audit }) {
  const changed = db
    .prepare(
      `UPDATE pipeline_work
       SET status = 'retry', lease_until = NULL, attempt_count = attempt_count + @increment,
           next_attempt_at = @nextAttemptAt, last_error = @lastError,
           payload_json = @payload, updated_at = @now
       WHERE kind = @kind AND key = @key AND status IN ${CLAIMABLE}`,
    )
    .run({
      kind,
      key,
      now: Date.now(),
      increment: countAttempt ? 1 : 0,
      nextAttemptAt,
      lastError,
      payload: toJson(payload) ?? '{}',
    });
  if (changed.changes) writeAudit(db, kind, key, audit);
  return changed.changes > 0;
}

/**
 * Finish an item successfully. `status` carries the domain's own vocabulary —
 * 'inactive' for an advert the provider has withdrawn, 'waiting_model' for a
 * listing no market model covers, 'sent' for a delivered notification — because
 * flattening those to 'completed' destroyed the only record of why an item
 * stopped moving.
 *
 * A cancelled item stays cancelled: terminal filtering is global, and a late
 * completion arriving after a listing was hidden must not undo the hiding.
 *
 * @param {string} kind
 * @param {string} key
 * @param {{status?: string, reason?: string|null, patch?: object|null, action?: string|null}} [options]
 * @returns {boolean} whether the item was still open and has now been finished
 */
export function completeWork(kind, key, { status = 'completed', reason = null, patch = null, action = null } = {}) {
  return SqliteConnection.withTransaction((db) =>
    terminate(db, kind, key, status, {
      reason,
      patch,
      action: action ?? status,
      guardCancelled: status !== 'cancelled',
    }),
  );
}

/**
 * Stop an item for good without touching its worker: a job that no longer
 * exists, a provider removed from the job, an advert a filter rejects.
 *
 * @param {string} kind
 * @param {string} key
 * @param {Error|string} reason
 * @param {{action?: string, classification?: object|null}} [options]
 */
export function cancelWork(kind, key, reason, { action = 'cancelled', classification = null } = {}) {
  SqliteConnection.withTransaction((db) => {
    terminate(db, kind, key, 'cancelled', { reason: message(reason), action, classification });
  });
}

/**
 * Cancel every kind of outstanding work for one listing.
 *
 * Terminal filtering is global: the rows stay, but nothing may keep working on a
 * listing the user will never see. Two lookups are needed because only some
 * payloads name a listing — a detail item is about a source that may not have
 * become a listing yet, so its work is found through the sources that point at
 * it.
 *
 * @param {string} listingId
 * @param {string} [reason]
 */
export function cancelWorkForListing(listingId, reason = 'Listing filtered') {
  if (!listingId) return;
  SqliteConnection.withTransaction((db) => {
    const rows = db
      .prepare(
        `SELECT kind, key FROM pipeline_work
         WHERE status IN ${CLAIMABLE}
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
      terminate(db, row.kind, row.key, 'cancelled', { reason: String(reason), action: 'cancelled' });
    }
  });
}

/**
 * Move an item to a terminal state, dropping the bulk evidence it was carrying.
 *
 * Every queue used to NULL its own payload columns on the way out, in four
 * places with three different sets of columns. The evidence itself is durable in
 * listing_source_observations and listing_texts; a second copy per finished item
 * is what made the queues the largest tables in the database.
 */
function terminate(db, kind, key, status, { reason, patch, payload, action, classification, guardCancelled = true }) {
  const row = selectRow(db, kind, key);
  if (!row) return false;
  const merged = { ...(payload ?? jsonObject(row.payload_json)), ...(patch ?? {}), completedAt: Date.now() };
  for (const bulk of BULK_PAYLOAD_KEYS) delete merged[bulk];
  const changed = db
    .prepare(
      `UPDATE pipeline_work
       SET status = @status, lease_until = NULL, last_error = @reason,
           payload_json = @payload, updated_at = @now
       WHERE kind = @kind AND key = @key ${guardCancelled ? "AND status != 'cancelled'" : ''}`,
    )
    .run({
      kind,
      key,
      status,
      reason: reason == null ? null : String(reason).slice(0, 2000),
      payload: toJson(merged) ?? '{}',
      now: Date.now(),
    });
  if (changed.changes && action) {
    writeAudit(db, kind, key, { action, reason, payload: classification });
  }
  return changed.changes > 0;
}

/**
 * One audit write for the whole queue. The listing is resolved from the payload
 * or from the source rows that point at this work item, so an event is still
 * attributable after the work is gone.
 *
 * @param {string} kind
 * @param {string} key
 * @param {{stage?: string|null, action: string, reason?: unknown, payload?: object|null}} event
 * @param {import('better-sqlite3').Database} [db] join an open transaction
 */
export function auditWork(kind, key, event, db = null) {
  if (db) {
    writeAudit(db, kind, key, event);
    return;
  }
  SqliteConnection.withTransaction((tx) => writeAudit(tx, kind, key, event));
}

function writeAudit(db, kind, key, { stage = null, action, reason = null, payload = null }) {
  // The audit log is observability, never a precondition: a database that does
  // not have it yet must still be able to drain its queue.
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

/**
 * Read one item without claiming it.
 * @returns {object|null}
 */
export function getWork(kind, key) {
  return hydrate(selectRow(SqliteConnection.getConnection(), kind, key));
}

/**
 * Every claimable item of `kind` that is due, oldest first. Used by the
 * notification dispatcher, which groups a burst into one digest and therefore
 * cannot take items one at a time.
 */
export function dueWork(kind, now = Date.now()) {
  return SqliteConnection.query(
    `SELECT * FROM pipeline_work
     WHERE kind = @kind AND status IN ${CLAIMABLE} AND next_attempt_at <= @now
     ORDER BY created_at ASC`,
    { kind, now },
  ).map(hydrate);
}

/**
 * When the next item of `kind` becomes due, or null when none is waiting. This
 * is what lets the dispatcher set one exact timer instead of polling.
 */
export function nextDueAt(kind) {
  return (
    SqliteConnection.getConnection()
      .prepare(
        `SELECT MIN(next_attempt_at) AS next_at FROM pipeline_work
         WHERE kind = @kind AND status IN ${CLAIMABLE}`,
      )
      .get({ kind })?.next_at ?? null
  );
}

/** Replace part of an item's payload without touching its scheduling. */
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

/**
 * Expose a row as `{...columns, payload}`. Callers add their own domain shape on
 * top; the queue itself knows nothing about what a payload means.
 */
function hydrate(row) {
  if (!row) return null;
  return { ...row, payload: jsonObject(row.payload_json) };
}

function message(error) {
  return String(error?.message || error).slice(0, 2000);
}

/**
 * Start the loop for one registered kind.
 *
 * Returns the worker's name when it actually started and null when its kill
 * switch is off, which is what lets the health endpoint tell "disabled on
 * purpose" apart from "failed to start".
 *
 * @param {string} kind
 * @returns {string|null}
 */
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

/**
 * Restart the drain loop if it ever escapes. A worker that has stopped draining
 * its queue while the process stays up is the failure this exists for: the
 * restart is counted, so the health endpoint shows a flapping worker instead of
 * a silent one.
 */
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

async function drain(spec) {
  while (true) {
    heartbeatWorker(spec.name);
    let item = null;
    try {
      item = claimWork(spec.kind, { leaseMs: spec.timeoutMs() + 60_000 });
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
        if (spec.onError?.(item, error)) continue;
        const maxFailures = spec.maxFailures?.() ?? null;
        const outcome = retryWork(spec.kind, item.key, error, { maxFailures, stage: spec.kind });
        if (outcome.status === 'dead') {
          logger.error(`Abandoned ${spec.kind} item '${item.key}' after ${outcome.attempts} failure(s).`, error);
        } else {
          logger.warn(`${spec.name} item '${item.key}' failed; scheduled another attempt.`, error);
        }
      } catch (recoveryError) {
        // Never let bookkeeping kill the loop: back off and keep running.
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
