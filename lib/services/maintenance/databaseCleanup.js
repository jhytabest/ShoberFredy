/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * What is kept forever, and what is not.
 *
 * The captured listing text is permanent. Every `capture_json` and every
 * observation `payload_json` is the raw evidence an ad presented at a point in
 * time — the description, the facts, the wording — and once the ad is taken
 * down there is nowhere left to fetch it from. It is the archive, not a cache,
 * so retention must never touch it. An earlier version of this file cleared it
 * after seven days and destroyed ~190 MB of listing text before that was
 * caught; the only reason it was recoverable was an unrelated backup.
 *
 * Downloaded images are likewise permanent, stored on disk and referenced by
 * `listing_images`. Nothing here has ever deleted them, and nothing should.
 *
 * Two things are still pruned, neither of which is listing evidence:
 *
 *   LLM audit bodies (days) — the prompt and raw HTTP response of each model
 *   call. Operational telemetry for debugging a bad extraction. The extraction
 *   itself is persisted separately in `listing_extractions` and
 *   `listing_attributes`, so clearing the transcript loses no listing fact.
 *
 *   Queue and audit rows (weeks) — the bookkeeping rows themselves, minus the
 *   capture columns they carry. Nothing deleted a single one before, so the
 *   counts only ever grew; a terminal row past the window will never be
 *   reconciled again. Their captures are preserved on the source and the
 *   observation, which are never deleted.
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

/** LLM call transcripts only — captures are permanent and never expire. */
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
  // Captures are never cleared. The only payloads pruned are the LLM call
  // transcripts, which are telemetry rather than evidence.
  const capturedDetail = `capture_json IS NOT NULL AND capture_json <> ''`;
  const capturedParsing = `capture_json <> ''`;
  return [
    {
      // The prompt and raw response of a model call. The extraction they
      // produced is stored in listing_extractions / listing_attributes, so
      // clearing the transcript costs no listing fact. `request_json` is NOT
      // NULL, hence the empty string rather than NULL.
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
      // Deleting a queue row deletes the capture column it carries with it, so
      // only rows that hold no text may go. Mirroring is not a safe assumption:
      // measured against live data, barely a third of parsing-queue captures
      // also existed on an observation, so "the text survives elsewhere" would
      // have been wrong for most of them.
      key: 'parsingRows',
      kind: 'delete',
      count: `SELECT COUNT(*) AS count FROM parsing_queue
              WHERE NOT (${capturedParsing})
                AND status IN (${placeholders(TERMINAL_PARSING_STATUSES)})
                AND COALESCE(completed_at, updated_at) < ?`,
      apply: `DELETE FROM parsing_queue
              WHERE NOT (${capturedParsing})
                AND status IN (${placeholders(TERMINAL_PARSING_STATUSES)})
                AND COALESCE(completed_at, updated_at) < ?`,
      params: [...TERMINAL_PARSING_STATUSES, row],
    },
    {
      key: 'detailRows',
      kind: 'delete',
      count: `SELECT COUNT(*) AS count FROM detail_fetch_queue
              WHERE NOT (${capturedDetail})
                AND status IN (${placeholders(TERMINAL_DETAIL_STATUSES)})
                AND COALESCE(completed_at, updated_at) < ?`,
      apply: `DELETE FROM detail_fetch_queue
              WHERE NOT (${capturedDetail})
                AND status IN (${placeholders(TERMINAL_DETAIL_STATUSES)})
                AND COALESCE(completed_at, updated_at) < ?`,
      params: [...TERMINAL_DETAIL_STATUSES, row],
    },
    {
      // Carries no capture of its own.
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
      llmTranscripts: days(now - cutoffs.payload),
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
