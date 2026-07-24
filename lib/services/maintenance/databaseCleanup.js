/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import logger from '../logger.js';

const TERMINAL_PARSING_STATUSES = ['cancelled', 'completed', 'duplicate', 'dead'];
const TERMINAL_DETAIL_STATUSES = ['cancelled', 'completed', 'inactive'];

function maintenanceCutoff(now = Date.now()) {
  const days = positiveEnv('FREDY_DB_PAYLOAD_RETENTION_DAYS', 30);
  return now - days * 24 * 60 * 60 * 1000;
}

export function previewDbMaintenance({ now = Date.now() } = {}) {
  const db = SqliteConnection.getConnection();
  const cutoff = maintenanceCutoff(now);
  return {
    cutoff,
    retentionDays: Math.round((now - cutoff) / (24 * 60 * 60 * 1000)),
    parsingPayloads: eligibleCount(
      db,
      `SELECT COUNT(*) AS count FROM parsing_queue
       WHERE capture_json IS NOT NULL
         AND status IN (${placeholders(TERMINAL_PARSING_STATUSES)})
         AND COALESCE(completed_at, updated_at) < ?`,
      [...TERMINAL_PARSING_STATUSES, cutoff],
    ),
    detailPayloads: eligibleCount(
      db,
      `SELECT COUNT(*) AS count FROM detail_fetch_queue
       WHERE capture_json IS NOT NULL
         AND status IN (${placeholders(TERMINAL_DETAIL_STATUSES)})
         AND COALESCE(completed_at, updated_at) < ?`,
      [...TERMINAL_DETAIL_STATUSES, cutoff],
    ),
    llmAuditPayloads: eligibleCount(
      db,
      `SELECT COUNT(*) AS count FROM llm_call_audit
       WHERE (request_json IS NOT NULL OR response_body IS NOT NULL OR response_headers_json IS NOT NULL)
         AND COALESCE(completed_at, started_at) < ?`,
      [cutoff],
    ),
    storage: storageStats(db),
  };
}

/**
 * Keep durable rows and audit metadata while clearing aged heavyweight payload
 * bodies. VACUUM remains explicit because it requires an exclusive lock.
 */
export function runDbMaintenance({ now = Date.now(), vacuum = process.env.FREDY_DB_VACUUM === '1' } = {}) {
  const db = SqliteConnection.getConnection();
  const cutoff = maintenanceCutoff(now);
  const summary = { cutoff, walPagesBefore: walPages(db) };

  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    logger.warn('wal_checkpoint(TRUNCATE) failed:', error.message);
  }

  summary.parsingCleared = clearColumn(
    db,
    `UPDATE parsing_queue SET capture_json = NULL
     WHERE capture_json IS NOT NULL
       AND status IN (${placeholders(TERMINAL_PARSING_STATUSES)})
       AND COALESCE(completed_at, updated_at) < ?`,
    [...TERMINAL_PARSING_STATUSES, cutoff],
  );
  summary.detailCleared = clearColumn(
    db,
    `UPDATE detail_fetch_queue SET capture_json = NULL
     WHERE capture_json IS NOT NULL
       AND status IN (${placeholders(TERMINAL_DETAIL_STATUSES)})
       AND COALESCE(completed_at, updated_at) < ?`,
    [...TERMINAL_DETAIL_STATUSES, cutoff],
  );
  summary.auditCleared = clearColumn(
    db,
    `UPDATE llm_call_audit
     SET request_json = NULL, response_body = NULL, response_headers_json = NULL
     WHERE (request_json IS NOT NULL OR response_body IS NOT NULL OR response_headers_json IS NOT NULL)
       AND COALESCE(completed_at, started_at) < ?`,
    [cutoff],
  );

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
    `DB maintenance: parsing_queue captures cleared=${summary.parsingCleared}, detail captures=${summary.detailCleared}, ` +
      `audit bodies=${summary.auditCleared}, WAL pages ${summary.walPagesBefore}→${summary.walPagesAfter}` +
      (summary.vacuumed ? ', vacuumed' : ''),
  );
  return summary;
}

function clearColumn(db, sql, params) {
  try {
    return db.prepare(sql).run(...params).changes;
  } catch (error) {
    logger.warn('DB maintenance update failed:', error.message);
    return 0;
  }
}

function eligibleCount(db, sql, params) {
  return db.prepare(sql).get(...params).count;
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
