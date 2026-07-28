/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Database maintenance. Nothing here deletes a row or clears a column.
 *
 * The database is an archive. Captured listing text, observation payloads,
 * downloaded images, LLM transcripts, queue rows and audit events are all kept
 * permanently: an ad that has been taken down cannot be fetched again, and the
 * bookkeeping around it is what explains why the pipeline decided as it did.
 *
 * Earlier versions expired payloads after seven days and terminal rows after
 * ninety. That destroyed ~190 MB of listing text before it was caught, and it
 * was recoverable only because an unrelated backup happened to exist. The
 * retention knobs are gone rather than defaulted to "off", so no environment
 * variable can switch expiry back on.
 *
 * What remains changes no data: fold the write-ahead log back into the main
 * file, refresh the query planner's statistics, and — only when explicitly
 * asked — repack the file to reclaim space left by deletions made in the past.
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import logger from '../logger.js';

/**
 * Report what the database holds. Read-only, and deliberately not a "preview of
 * what would be removed": nothing is ever removed.
 *
 * @returns {object} archive and storage statistics
 */
export function previewDbMaintenance() {
  const db = SqliteConnection.getConnection();
  return {
    policy: 'retain-everything',
    archive: archiveStats(db),
    storage: storageStats(db),
  };
}

/**
 * Run the non-destructive upkeep. VACUUM stays opt-in because it needs an
 * exclusive lock on the whole database.
 *
 * @param {{vacuum?: boolean}} [options]
 * @returns {object} summary including before/after storage
 */
export function runDbMaintenance({ vacuum = process.env.FREDY_DB_VACUUM === '1' } = {}) {
  const db = SqliteConnection.getConnection();
  const summary = { policy: 'retain-everything', walPagesBefore: walPages(db) };

  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    logger.warn('wal_checkpoint(TRUNCATE) failed:', error.message);
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
  summary.archive = archiveStats(db);
  summary.storage = storageStats(db);
  logger.info(
    `DB maintenance (retain-everything): WAL pages ${summary.walPagesBefore}→${summary.walPagesAfter}, ` +
      `${summary.archive.captureTextMb} MB captured text across ${summary.archive.observations} observations` +
      (summary.vacuumed ? ', vacuumed' : ''),
  );
  return summary;
}

/** What the archive is holding, so growth stays visible in the daily log line. */
function archiveStats(db) {
  const scalar = (sql) => {
    try {
      return db.prepare(sql).get().value ?? 0;
    } catch {
      return 0;
    }
  };
  const bytes =
    scalar(`SELECT COALESCE(SUM(LENGTH(capture_json)), 0) AS value FROM detail_fetch_queue`) +
    scalar(`SELECT COALESCE(SUM(LENGTH(capture_json)), 0) AS value FROM parsing_queue`) +
    scalar(`SELECT COALESCE(SUM(LENGTH(capture_json)), 0) AS value FROM listing_sources`) +
    scalar(`SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS value FROM listing_source_observations`);
  return {
    captureTextMb: Math.round((bytes / 1048576) * 10) / 10,
    observations: scalar(`SELECT COUNT(*) AS value FROM listing_source_observations`),
    listings: scalar(`SELECT COUNT(*) AS value FROM listings`),
    storedImages: scalar(`SELECT COUNT(*) AS value FROM listing_images WHERE download_status = 'stored'`),
  };
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
