/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Nightly SQLite maintenance. The durable pipeline retains terminal queue rows
 * and a full LLM call audit forever (by design), and their heavy payload
 * columns (capture_json, request/response bodies) dominate database size — the
 * WAL is also never truncated on its own while long-lived worker readers hold
 * snapshots. This task keeps the database bounded WITHOUT deleting any row or
 * breaking the audit trail:
 *
 *   1. wal_checkpoint(TRUNCATE) — reclaim the write-ahead log.
 *   2. Null the heavy payload columns on TERMINAL rows older than the retention
 *      window (the row, its status, timing and FKs stay for audit).
 *   3. PRAGMA optimize; optional VACUUM (opt-in, exclusive-lock, off by default).
 *
 * Nothing here deletes rows, so the parsing_queue ON DELETE CASCADE audit
 * children are never touched. Because auto_vacuum is off, nulling payloads
 * bounds GROWTH (freed pages are reused) rather than shrinking the file; set
 * FREDY_DB_VACUUM=1 to reclaim to the OS during a maintenance window.
 */

import cron from 'node-cron';
import SqliteConnection from '../storage/SqliteConnection.js';
import logger from '../logger.js';
import { getSettings } from '../storage/settingsStorage.js';

function retentionCutoff(now = Date.now()) {
  const days = positiveEnv('FREDY_DB_PAYLOAD_RETENTION_DAYS', 30);
  return now - days * 24 * 60 * 60 * 1000;
}

export function runDbMaintenance({ now = Date.now() } = {}) {
  const db = SqliteConnection.getConnection();
  const cutoff = retentionCutoff(now);
  const summary = { walPagesBefore: walPages(db) };

  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    logger.warn('wal_checkpoint(TRUNCATE) failed:', error.message);
  }

  summary.parsingCleared = clearColumn(
    db,
    `UPDATE parsing_queue SET capture_json = NULL
     WHERE capture_json IS NOT NULL AND status IN ('cancelled', 'completed', 'duplicate')
       AND COALESCE(completed_at, updated_at) < @cutoff`,
    cutoff,
  );
  summary.detailCleared = clearColumn(
    db,
    `UPDATE detail_fetch_queue SET capture_json = NULL
     WHERE capture_json IS NOT NULL AND status IN ('cancelled', 'completed', 'inactive')
       AND COALESCE(completed_at, updated_at) < @cutoff`,
    cutoff,
  );
  // Keep the audit row (model, outcome, usage, timing, error) but drop the bulky
  // request/response bodies once they age out.
  summary.auditCleared = clearColumn(
    db,
    `UPDATE llm_call_audit SET request_json = NULL, response_body = NULL, response_headers_json = NULL
     WHERE (request_json IS NOT NULL OR response_body IS NOT NULL)
       AND COALESCE(completed_at, started_at) < @cutoff`,
    cutoff,
  );

  try {
    db.pragma('optimize');
  } catch (error) {
    logger.debug('PRAGMA optimize failed:', error.message);
  }

  if (process.env.FREDY_DB_VACUUM === '1') {
    try {
      db.exec('VACUUM');
      summary.vacuumed = true;
    } catch (error) {
      logger.warn('VACUUM failed (database stays functional):', error.message);
    }
  }

  summary.walPagesAfter = walPages(db);
  logger.info(
    `DB maintenance: parsing_queue captures cleared=${summary.parsingCleared}, detail captures=${summary.detailCleared}, ` +
      `audit bodies=${summary.auditCleared}, WAL pages ${summary.walPagesBefore}→${summary.walPagesAfter}` +
      (summary.vacuumed ? ', vacuumed' : ''),
  );
  return summary;
}

export async function initDbMaintenanceCron() {
  if (process.env.FREDY_DB_MAINTENANCE_ENABLED === '0') {
    logger.info('DB maintenance cron is disabled.');
    return;
  }
  const settings = await getSettings();
  if (settings.demoMode) return;
  // Daily at 02:30, after the market retrain / active-checker windows.
  cron.schedule('30 2 * * *', () => {
    try {
      runDbMaintenance();
    } catch (error) {
      logger.error('DB maintenance run failed:', error);
    }
  });
  logger.info('DB maintenance cron scheduled (daily 02:30).');
}

function clearColumn(db, sql, cutoff) {
  try {
    return db.prepare(sql).run({ cutoff }).changes;
  } catch (error) {
    logger.warn('DB maintenance update failed:', error.message);
    return 0;
  }
}

function walPages(db) {
  try {
    // wal_checkpoint returns [busy, log, checkpointed]; log = WAL size in pages.
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
