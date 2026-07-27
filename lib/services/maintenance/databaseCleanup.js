/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Retention has two tiers, because the two problems are different.
 *
 * Payload tier (days): the captured HTML, discovery cards, observation bodies
 * and LLM request/response bodies. These are what make the database large —
 * they dominate every heavy table — and they stop being useful within days,
 * once the listing has been parsed and either notified or filtered.
 *
 * Row tier (weeks): the queue and audit rows themselves. They are small
 * individually but unbounded in number, and nothing used to delete a single
 * one, so the row counts only ever grew. Terminal queue rows and audit events
 * are deleted once they are old enough that no reconciliation will look at
 * them again.
 *
 * Listings, notification history, geocode cache and the market model are never
 * touched by either tier.
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import logger from '../logger.js';

const TERMINAL_PARSING_STATUSES = ['cancelled', 'completed', 'duplicate', 'dead'];
const TERMINAL_DETAIL_STATUSES = ['cancelled', 'completed', 'inactive'];
// 'waiting_model' and 'unrated' look terminal but are not: every market retrain
// resets them to 'pending' so a new model gets a chance to score them.
const TERMINAL_RATING_STATUSES = ['cancelled', 'completed'];

function cutoffFor(envName, fallbackDays, now) {
  return now - positiveEnv(envName, fallbackDays) * 24 * 60 * 60 * 1000;
}

/** Heavyweight bodies: short window, they are dead weight almost immediately. */
function payloadCutoff(now = Date.now()) {
  return cutoffFor('FREDY_DB_PAYLOAD_RETENTION_DAYS', 7, now);
}

/** Terminal queue rows: kept long enough for after-the-fact investigation. */
function rowCutoff(now = Date.now()) {
  return cutoffFor('FREDY_DB_ROW_RETENTION_DAYS', 90, now);
}

/**
 * Audit events are emitted per source per job, so a single blacklisted listing
 * writes several. At roughly ten thousand rows a day they need a tighter window
 * than the queues they describe.
 */
function auditCutoff(now = Date.now()) {
  return cutoffFor('FREDY_DB_AUDIT_RETENTION_DAYS', 30, now);
}

/**
 * Every statement maintenance runs, as data, so the preview and the run cannot
 * drift apart: the preview counts exactly what the run would change.
 *
 * @param {{payload: number, row: number, audit: number}} cutoffs
 * @returns {{key: string, kind: 'clear'|'delete', count: string, apply: string, params: any[]}[]}
 */
function operations({ payload, row, audit }) {
  return [
    {
      // `capture_json` is NOT NULL here, so the obvious `SET … = NULL` raises a
      // constraint error rather than clearing anything. It did exactly that on
      // every run, silently, which is why this table grew to be one of the
      // largest in the database. Emptying the string is what the column allows.
      key: 'parsingCaptures',
      kind: 'clear',
      count: `SELECT COUNT(*) AS count FROM parsing_queue
              WHERE capture_json <> ''
                AND status IN (${placeholders(TERMINAL_PARSING_STATUSES)})
                AND COALESCE(completed_at, updated_at) < ?`,
      apply: `UPDATE parsing_queue SET capture_json = ''
              WHERE capture_json <> ''
                AND status IN (${placeholders(TERMINAL_PARSING_STATUSES)})
                AND COALESCE(completed_at, updated_at) < ?`,
      params: [...TERMINAL_PARSING_STATUSES, payload],
    },
    {
      key: 'detailCaptures',
      kind: 'clear',
      count: `SELECT COUNT(*) AS count FROM detail_fetch_queue
              WHERE capture_json IS NOT NULL
                AND status IN (${placeholders(TERMINAL_DETAIL_STATUSES)})
                AND COALESCE(completed_at, updated_at) < ?`,
      apply: `UPDATE detail_fetch_queue SET capture_json = NULL
              WHERE capture_json IS NOT NULL
                AND status IN (${placeholders(TERMINAL_DETAIL_STATUSES)})
                AND COALESCE(completed_at, updated_at) < ?`,
      params: [...TERMINAL_DETAIL_STATUSES, payload],
    },
    {
      // The identity columns (source_key, dedupe keys, listing_id) stay: they
      // are what keeps a re-discovered ad from being notified twice. Only the
      // captured bodies go.
      key: 'sourceCaptures',
      kind: 'clear',
      count: `SELECT COUNT(*) AS count FROM listing_sources
              WHERE capture_json IS NOT NULL AND last_seen_at < ?`,
      apply: `UPDATE listing_sources SET capture_json = NULL
              WHERE capture_json IS NOT NULL AND last_seen_at < ?`,
      params: [payload],
    },
    {
      // content_hash is retained, so change detection still works against an
      // emptied payload.
      key: 'observationPayloads',
      kind: 'clear',
      count: `SELECT COUNT(*) AS count FROM listing_source_observations
              WHERE payload_json <> '' AND observed_at < ?`,
      apply: `UPDATE listing_source_observations SET payload_json = ''
              WHERE payload_json <> '' AND observed_at < ?`,
      params: [payload],
    },
    {
      // `request_json` is NOT NULL and carries the prompt, which is the bulk of
      // the row; it has the same silent-failure history as the parsing capture
      // above. The two nullable response columns can still go to NULL.
      key: 'llmAuditBodies',
      kind: 'clear',
      count: `SELECT COUNT(*) AS count FROM llm_call_audit
              WHERE (request_json <> '' OR response_body IS NOT NULL OR response_headers_json IS NOT NULL)
                AND COALESCE(completed_at, started_at) < ?`,
      apply: `UPDATE llm_call_audit
              SET request_json = '', response_body = NULL, response_headers_json = NULL
              WHERE (request_json <> '' OR response_body IS NOT NULL OR response_headers_json IS NOT NULL)
                AND COALESCE(completed_at, started_at) < ?`,
      params: [payload],
    },
    {
      key: 'auditEvents',
      kind: 'delete',
      count: `SELECT COUNT(*) AS count FROM pipeline_audit_events WHERE created_at < ?`,
      apply: `DELETE FROM pipeline_audit_events WHERE created_at < ?`,
      params: [audit],
    },
    {
      key: 'parsingRows',
      kind: 'delete',
      count: `SELECT COUNT(*) AS count FROM parsing_queue
              WHERE status IN (${placeholders(TERMINAL_PARSING_STATUSES)})
                AND COALESCE(completed_at, updated_at) < ?`,
      apply: `DELETE FROM parsing_queue
              WHERE status IN (${placeholders(TERMINAL_PARSING_STATUSES)})
                AND COALESCE(completed_at, updated_at) < ?`,
      params: [...TERMINAL_PARSING_STATUSES, row],
    },
    {
      key: 'detailRows',
      kind: 'delete',
      count: `SELECT COUNT(*) AS count FROM detail_fetch_queue
              WHERE status IN (${placeholders(TERMINAL_DETAIL_STATUSES)})
                AND COALESCE(completed_at, updated_at) < ?`,
      apply: `DELETE FROM detail_fetch_queue
              WHERE status IN (${placeholders(TERMINAL_DETAIL_STATUSES)})
                AND COALESCE(completed_at, updated_at) < ?`,
      params: [...TERMINAL_DETAIL_STATUSES, row],
    },
    {
      key: 'ratingRows',
      kind: 'delete',
      count: `SELECT COUNT(*) AS count FROM rating_queue
              WHERE status IN (${placeholders(TERMINAL_RATING_STATUSES)})
                AND COALESCE(completed_at, updated_at) < ?`,
      apply: `DELETE FROM rating_queue
              WHERE status IN (${placeholders(TERMINAL_RATING_STATUSES)})
                AND COALESCE(completed_at, updated_at) < ?`,
      params: [...TERMINAL_RATING_STATUSES, row],
    },
    {
      key: 'llmAuditRows',
      kind: 'delete',
      count: `SELECT COUNT(*) AS count FROM llm_call_audit WHERE COALESCE(completed_at, started_at) < ?`,
      apply: `DELETE FROM llm_call_audit WHERE COALESCE(completed_at, started_at) < ?`,
      params: [row],
    },
    {
      key: 'processingAttempts',
      kind: 'delete',
      count: `SELECT COUNT(*) AS count FROM processing_attempts WHERE started_at < ?`,
      apply: `DELETE FROM processing_attempts WHERE started_at < ?`,
      params: [row],
    },
  ];
}

export function previewDbMaintenance({ now = Date.now() } = {}) {
  const db = SqliteConnection.getConnection();
  const cutoffs = { payload: payloadCutoff(now), row: rowCutoff(now), audit: auditCutoff(now) };
  const eligible = {};
  for (const operation of operations(cutoffs)) {
    eligible[operation.key] = { kind: operation.kind, count: safeCount(db, operation.count, operation.params) };
  }
  return {
    cutoffs,
    retentionDays: {
      payloads: days(now - cutoffs.payload),
      rows: days(now - cutoffs.row),
      auditEvents: days(now - cutoffs.audit),
    },
    eligible,
    storage: storageStats(db),
  };
}

/**
 * Clear aged payload bodies and delete aged terminal rows. VACUUM stays
 * explicit because it needs an exclusive lock on the whole database.
 */
export function runDbMaintenance({ now = Date.now(), vacuum = process.env.FREDY_DB_VACUUM === '1' } = {}) {
  const db = SqliteConnection.getConnection();
  const cutoffs = { payload: payloadCutoff(now), row: rowCutoff(now), audit: auditCutoff(now) };
  const summary = { cutoffs, walPagesBefore: walPages(db), cleared: {}, deleted: {} };

  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    logger.warn('wal_checkpoint(TRUNCATE) failed:', error.message);
  }

  for (const operation of operations(cutoffs)) {
    const changed = applyStatement(db, operation.apply, operation.params);
    const bucket = operation.kind === 'delete' ? summary.deleted : summary.cleared;
    bucket[operation.key] = changed;
  }

  try {
    db.pragma('optimize');
  } catch (error) {
    logger.debug('PRAGMA optimize failed:', error.message);
  }

  if (vacuum) {
    db.exec('VACUUM');
    summary.vacuumed = true;
  }

  summary.walPagesAfter = walPages(db);
  summary.storage = storageStats(db);
  logger.info(
    `DB maintenance: cleared ${describe(summary.cleared)}; deleted ${describe(summary.deleted)}; ` +
      `WAL pages ${summary.walPagesBefore}→${summary.walPagesAfter}` +
      (summary.vacuumed ? ', vacuumed' : ''),
  );
  return summary;
}

function describe(counts) {
  const parts = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key}=${value}`);
  return parts.length ? parts.join(', ') : 'nothing';
}

function applyStatement(db, sql, params) {
  try {
    return db.prepare(sql).run(...params).changes;
  } catch (error) {
    logger.warn('DB maintenance statement failed:', error.message);
    return 0;
  }
}

function safeCount(db, sql, params) {
  try {
    return db.prepare(sql).get(...params).count;
  } catch (error) {
    logger.warn('DB maintenance preview failed:', error.message);
    return 0;
  }
}

function days(ms) {
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function storageStats(db) {
  const pageSize = db.pragma('page_size', { simple: true });
  const pageCount = db.pragma('page_count', { simple: true });
  const freePages = db.pragma('freelist_count', { simple: true });
  return {
    pageSize,
    pageCount,
    freePages,
    databaseBytes: pageSize * pageCount,
    reusableBytes: pageSize * freePages,
  };
}

function walPages(db) {
  try {
    const [row] = db.pragma('wal_checkpoint(PASSIVE)');
    return row?.log ?? -1;
  } catch {
    return -1;
  }
}

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
