/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import logger from '../logger.js';
import { retainAuditPayloads } from './payloadRetention.js';
import { env } from '../../shared/env.js';
import fs from 'node:fs';
import path from 'node:path';

export function previewDbMaintenance() {
  const db = SqliteConnection.getConnection();
  return {
    policy: 'durable-history-bounded-payloads',
    archive: archiveStats(db),
    media: mediaStats(db),
    storage: storageStats(db),
  };
}

export function runDbMaintenance({ vacuum = env('FREDY_DB_VACUUM') } = {}) {
  const db = SqliteConnection.getConnection();
  const summary = { policy: 'durable-history-bounded-payloads', walPagesBefore: walPages(db) };

  summary.retention = retainAuditPayloads(db);
  logger.event('audit_retention', 'info', { ...summary.retention, days: env('FREDY_AUDIT_PAYLOAD_DAYS') });
  summary.expiredImages = expireImages(db);

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
  summary.clearedTerminalPayloads = summary.retention.terminalCapturesTrimmed;
  summary.missingImages = reconcileMissingImages(db);
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
  let removed = 0;
  for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.webp')) continue;
    files += 1;
    if (referenced.has(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    orphanFiles += 1;
    orphanBytes += fs.statSync(file).size;
    if (removeOrphans) {
      // Files written by an in-flight detail capture have no database reference yet.
      if (Date.now() - fs.statSync(file).mtimeMs < 24 * 60 * 60 * 1000) continue;
      fs.unlinkSync(file);
      logger.event('orphan_media_removed', 'info', { file });
      removed += 1;
    }
  }
  return { directory: mediaDir, files, orphanFiles, orphanBytes, removed };
}

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

function reconcileMissingImages(db) {
  const paths = db
    .prepare(
      `SELECT DISTINCT storage_path FROM listing_images
    WHERE download_status = 'stored' AND storage_path IS NOT NULL`,
    )
    .all();
  let missing = 0;
  db.transaction(() => {
    for (const { storage_path: storagePath } of paths) {
      if (fs.existsSync(storagePath)) continue;
      const changed = db
        .prepare(
          `UPDATE listing_images SET download_status = 'missing',
        error = 'Stored image file is missing; original URL and hash retained' WHERE storage_path = ? AND download_status = 'stored'`,
        )
        .run(storagePath).changes;
      missing += changed;
      logger.event('media_reference_missing', 'info', { storagePath, references: changed });
    }
  })();
  return missing;
}

// Expire a shared file only after every reference's retention ends. File mtime
// also protects a just-downloaded image whose capture has not committed yet.
function expireImages(db) {
  const now = Date.now();
  const duration = env('FREDY_MEDIA_RETENTION_DAYS') * 86400000;
  const databaseFile = db.pragma('database_list').find(({ name }) => name === 'main')?.file;
  if (!databaseFile) return { files: 0, references: 0 };
  const mediaRoot = path.resolve(path.dirname(databaseFile), 'media');
  const rows = db
    .prepare(
      `SELECT storage_path, MAX(retained_until) AS retained_until
    FROM listing_images WHERE download_status = 'stored' AND storage_path IS NOT NULL GROUP BY storage_path`,
    )
    .all();
  let files = 0;
  let references = 0;
  for (const row of rows) {
    const file = path.resolve(row.storage_path);
    if (!file.startsWith(mediaRoot + path.sep)) continue;
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const until = Math.max(row.retained_until || 0, stat.mtimeMs + duration);
    if (until > now) continue;
    // No await: new references cannot commit between the check and removal in
    // this single-process application. A crash is reconciled as missing later.
    fs.unlinkSync(file);
    const changed = db
      .prepare(
        `UPDATE listing_images SET download_status = 'expired',
      storage_path = NULL, removed_at = ?, error = 'Picture retention elapsed; source URL and content hash retained'
      WHERE storage_path = ? AND download_status = 'stored'`,
      )
      .run(now, row.storage_path).changes;
    files += 1;
    references += changed;
    logger.event('media_expired', 'info', { file, references: changed, bytes: stat.size, retainedUntil: until });
  }
  return { files, references };
}
