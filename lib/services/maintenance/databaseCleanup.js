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
 * How long a finished work row is kept. Thirty days outlives every retry window
 * in the system by more than an order of magnitude, and a listing that reappears
 * after a month is genuinely worth looking at again.
 */
const TERMINAL_WORK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

  const prunedWork = pruneTerminalWork(db);

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
  summary.prunedTerminalWork = prunedWork;
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

/**
 * Age out finished work rows.
 *
 * A terminal row is history, but it was also doing a second job: `enqueueWork`
 * compares a stored fingerprint before re-queueing, so 18000 finished rows were
 * acting as a "have I seen this advert" index — a third identity store beside
 * `listing_claims` and `listing_sources`, and the only one with no retention. It
 * can be pruned now that every listing, rejected ones included, records the
 * claims that recognise it: a re-sighting resolves against the listing rather
 * than against the queue. The window is generous because the only cost of
 * keeping a row is bytes, while dropping one that a live retry still needs is a
 * duplicate notification — so anything not yet terminal is untouchable, and
 * `pipeline_audit_events` keeps the trail either way.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number} rows removed
 */
function pruneTerminalWork(db) {
  const cutoff = Date.now() - TERMINAL_WORK_RETENTION_MS;
  return db
    .prepare(
      `DELETE FROM pipeline_work
       WHERE status NOT IN ${CLAIMABLE_SQL}
         AND updated_at < ?`,
    )
    .run(cutoff).changes;
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
