/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { getMigrationStatus } from '../storage/migrations/migrate.js';
import { findCanonicalDuplicateClusters, summarizeCanonicalDuplicates } from './canonicalDedupe.js';
import { previewDbMaintenance } from './databaseCleanup.js';

export function buildDatabaseMaintenanceReport(db) {
  const quickCheck = db.pragma('quick_check').map((row) => Object.values(row)[0]);
  const foreignKeyViolations = db.pragma('foreign_key_check');
  const duplicateClusters = findCanonicalDuplicateClusters(db);
  const migrations = getMigrationStatus(db);
  const manualOrphans = manualOrphanCounts(db);
  const archives = archiveMetadata(db);
  const duplicates = summarizeCanonicalDuplicates(duplicateClusters);
  return {
    healthy:
      migrations.upToDate &&
      quickCheck.length === 1 &&
      quickCheck[0] === 'ok' &&
      foreignKeyViolations.length === 0 &&
      Object.values(manualOrphans).every((count) => count === 0) &&
      archives.preLlm.invalidMetadata === 0 &&
      archives.canonicalMerges.invalidMetadata === 0 &&
      duplicates.duplicatesToMerge === 0,
    migrations,
    integrity: {
      quickCheck,
      foreignKeyViolations: foreignKeyViolations.length,
      manualOrphans,
    },
    listings: {
      bySchema: groupCounts(db, 'SELECT canonical_schema_version AS value, COUNT(*) AS count FROM listings GROUP BY 1'),
      visibleBySchema: groupCounts(
        db,
        `SELECT canonical_schema_version AS value, COUNT(*) AS count
         FROM listings
         WHERE manually_deleted = 0 AND hidden_reason IS NULL
         GROUP BY 1`,
      ),
      hiddenByReason: groupCounts(
        db,
        `SELECT COALESCE(hidden_reason, 'manual') AS value, COUNT(*) AS count
         FROM listings
         WHERE manually_deleted = 1 OR hidden_reason IS NOT NULL
         GROUP BY 1`,
      ),
      legacySnapshots: scalar(db, 'SELECT COUNT(*) FROM listings WHERE legacy_snapshot_json IS NOT NULL'),
    },
    queues: {
      parsing: groupedRows(db, 'SELECT queue_kind, status, stage, COUNT(*) AS count FROM parsing_queue GROUP BY 1,2,3'),
      detail: groupedRows(db, 'SELECT status, COUNT(*) AS count FROM detail_fetch_queue GROUP BY 1'),
      rating: groupedRows(db, 'SELECT status, COUNT(*) AS count FROM rating_queue GROUP BY 1'),
    },
    archives,
    duplicates,
    cleanup: previewDbMaintenance(),
  };
}

export function verifyArchivePayloads(db) {
  const tables = [
    { table: 'pre_llm_archive_listings', id: 'listing_id' },
    { table: 'canonical_merge_archive', id: 'duplicate_listing_id' },
  ];
  const result = { valid: true, tables: {} };
  for (const { table, id } of tables) {
    const summary = { checked: 0, invalid: [] };
    if (!tableExists(db, table)) {
      summary.missing = true;
      result.valid = false;
      result.tables[table] = summary;
      continue;
    }
    const rows = db.prepare(`SELECT ${id} AS id, payload_gzip, payload_sha256 FROM ${table}`).iterate();
    for (const row of rows) {
      summary.checked++;
      try {
        const payload = gunzipSync(row.payload_gzip);
        const digest = crypto.createHash('sha256').update(payload).digest('hex');
        if (digest !== row.payload_sha256) summary.invalid.push({ id: row.id, reason: 'sha256_mismatch' });
      } catch (error) {
        summary.invalid.push({ id: row.id, reason: error.message });
      }
    }
    if (summary.invalid.length) result.valid = false;
    result.tables[table] = summary;
  }
  return result;
}

function archiveMetadata(db) {
  return {
    preLlm: archiveTableMetadata(db, 'pre_llm_archive_listings'),
    canonicalMerges: archiveTableMetadata(db, 'canonical_merge_archive'),
    preLlmRuns: tableExists(db, 'pre_llm_archive_runs')
      ? groupedRows(
          db,
          `SELECT status, COUNT(*) AS count, SUM(archived_count) AS archived,
                  SUM(migrated_count) AS migrated, SUM(repaired_count) AS repaired
           FROM pre_llm_archive_runs GROUP BY 1`,
        )
      : [],
  };
}

function archiveTableMetadata(db, table) {
  if (!tableExists(db, table)) return { exists: false, count: 0 };
  return {
    exists: true,
    ...db
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(compressed_bytes), 0) AS compressedBytes,
                SUM(CASE WHEN length(payload_gzip) = 0 OR payload_sha256 IS NULL THEN 1 ELSE 0 END) AS invalidMetadata
         FROM ${table}`,
      )
      .get(),
  };
}

function manualOrphanCounts(db) {
  return {
    llmListing: scalar(
      db,
      `SELECT COUNT(*) FROM llm_call_audit audit
       LEFT JOIN listings listing ON listing.id = audit.listing_id
       WHERE audit.listing_id IS NOT NULL AND listing.id IS NULL`,
    ),
    llmQueue: scalar(
      db,
      `SELECT COUNT(*) FROM llm_call_audit audit
       LEFT JOIN parsing_queue queue ON queue.id = audit.queue_id
       WHERE audit.queue_id IS NOT NULL AND queue.id IS NULL`,
    ),
    auditListing: scalar(
      db,
      `SELECT COUNT(*) FROM pipeline_audit_events audit
       LEFT JOIN listings listing ON listing.id = audit.listing_id
       WHERE audit.listing_id IS NOT NULL AND listing.id IS NULL`,
    ),
    auditSource: scalar(
      db,
      `SELECT COUNT(*) FROM pipeline_audit_events audit
       LEFT JOIN listing_sources source ON source.id = audit.source_id
       WHERE audit.source_id IS NOT NULL AND source.id IS NULL`,
    ),
  };
}

function groupCounts(db, sql) {
  return Object.fromEntries(
    db
      .prepare(sql)
      .all()
      .map(({ value, count }) => [String(value), count]),
  );
}

function groupedRows(db, sql) {
  return db.prepare(sql).all();
}

function scalar(db, sql) {
  return db.prepare(sql).pluck().get();
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}
