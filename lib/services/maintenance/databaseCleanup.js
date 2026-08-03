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
import { CLAIMABLE_SQL } from '../pipeline/workQueue.js';
import { env } from '../../shared/env.js';
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
export function runDbMaintenance({ vacuum = env('FREDY_DB_VACUUM') } = {}) {
  const db = SqliteConnection.getConnection();
  const summary = { policy: 'one-listing-text', walPagesBefore: walPages(db) };

  // Deduplication, not deletion: this drops the bulk evidence copy from work rows
  // that are already finished, and the page text is durable in `listing_texts`
  // with the sighting in `listing_source_observations`. Nothing removed here is
  // the only copy of anything.
  //
  // Finished rows themselves are kept forever. They used to be aged out after
  // thirty days, which was the one place the database destroyed content on a
  // timer; `pipeline_audit_events` is not a substitute for the row that explains
  // what an item became.
  const cleared = db
    .prepare(
      `UPDATE pipeline_work
       SET payload_json = json_remove(payload_json, '$.capture', '$.discovery')
       WHERE status NOT IN ${CLAIMABLE_SQL}
         AND json_valid(payload_json)
         AND (
           json_type(payload_json, '$.capture') IS NOT NULL
           OR json_type(payload_json, '$.discovery') IS NOT NULL
         )`,
    )
    .run().changes;

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
  // Images live one directory deep, sharded by the first byte of their hash
  // (media/29/29b3….webp). A flat scan matched only `isFile()` entries at the
  // top level, found none, and so reported zero files and zero orphans for as
  // long as sharding has existed — while every unreferenced image stayed on
  // disk. Recursing is the whole fix; content addressing already shares files
  // between listings, so "no row references this name" remains the only test
  // for an orphan.
  for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.webp')) continue;
    files += 1;
    if (referenced.has(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
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
  const transientBytes = scalar(
    `SELECT COALESCE(SUM(
       LENGTH(COALESCE(json_extract(payload_json, '$.capture'), '')) +
       LENGTH(COALESCE(json_extract(payload_json, '$.discovery'), ''))
     ), 0) AS value
     FROM pipeline_work`,
  );
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
