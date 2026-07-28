/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Explicit, operator-run database upkeep. Listing text is permanent in
 * listing_texts; queue payloads are working state and are cleared only after
 * their durable result has been attached to a listing.
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import logger from '../logger.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Report retained content and transient payload storage without changing data.
 *
 * @returns {object} archive and storage statistics
 */
export function previewDbMaintenance() {
  const db = SqliteConnection.getConnection();
  return {
    policy: 'one-listing-text',
    archive: archiveStats(db),
    media: mediaStats(db),
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
  const summary = { policy: 'one-listing-text', walPagesBefore: walPages(db) };

  const cleared = db.transaction(() => {
    const parsing = db
      .prepare(
        `UPDATE parsing_queue SET capture_json = NULL
         WHERE capture_json IS NOT NULL
           AND status IN ('completed','duplicate','dead','cancelled')`,
      )
      .run().changes;
    const detail = db
      .prepare(
        `UPDATE detail_fetch_queue SET discovery_json = NULL, capture_json = NULL
         WHERE (discovery_json IS NOT NULL OR capture_json IS NOT NULL)
           AND status IN ('completed','inactive','cancelled')`,
      )
      .run().changes;
    return { parsing, detail };
  })();

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
  summary.clearedTerminalPayloads = cleared;
  summary.media = mediaStats(db, true);
  summary.archive = archiveStats(db);
  summary.storage = storageStats(db);
  logger.info(
    `DB maintenance: WAL pages ${summary.walPagesBefore}→${summary.walPagesAfter}, ` +
      `${summary.archive.listingTextMb} MB retained listing text` +
      (summary.vacuumed ? ', vacuumed' : ''),
  );
  return summary;
}

function mediaStats(db, removeOrphans = false) {
  const databaseFile = db.pragma('database_list').find(({ name }) => name === 'main')?.file;
  const mediaDir = databaseFile ? path.join(path.dirname(databaseFile), 'media') : null;
  if (!mediaDir || !fs.existsSync(mediaDir)) return { directory: mediaDir, files: 0, orphanFiles: 0, orphanBytes: 0 };
  const referenced = new Set(
    db
      .prepare(
        `SELECT DISTINCT storage_path FROM listing_images
         WHERE download_status = 'stored' AND storage_path IS NOT NULL`,
      )
      .all()
      .map(({ storage_path }) => path.basename(storage_path)),
  );
  let files = 0;
  let orphanFiles = 0;
  let orphanBytes = 0;
  for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.webp')) continue;
    files += 1;
    if (referenced.has(entry.name)) continue;
    const file = path.join(mediaDir, entry.name);
    orphanFiles += 1;
    orphanBytes += fs.statSync(file).size;
    if (removeOrphans) fs.unlinkSync(file);
  }
  return { directory: mediaDir, files, orphanFiles, orphanBytes, removed: removeOrphans ? orphanFiles : 0 };
}

/** Retained and transient content, so unexpected growth remains visible. */
function archiveStats(db) {
  const scalar = (sql) => {
    try {
      return db.prepare(sql).get().value ?? 0;
    } catch {
      return 0;
    }
  };
  const transientBytes =
    scalar(`SELECT COALESCE(SUM(LENGTH(capture_json)), 0) AS value FROM detail_fetch_queue`) +
    scalar(`SELECT COALESCE(SUM(LENGTH(discovery_json)), 0) AS value FROM detail_fetch_queue`) +
    scalar(`SELECT COALESCE(SUM(LENGTH(capture_json)), 0) AS value FROM parsing_queue`);
  const listingTextBytes = scalar(`SELECT COALESCE(SUM(LENGTH(full_text)), 0) AS value FROM listing_texts`);
  return {
    listingTextMb: Math.round((listingTextBytes / 1048576) * 10) / 10,
    transientPayloadMb: Math.round((transientBytes / 1048576) * 10) / 10,
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
