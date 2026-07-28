/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getMigrationStatus } from '../storage/migrations/migrate.js';
import { findCanonicalDuplicateClusters, summarizeCanonicalDuplicates } from './canonicalDedupe.js';
import { previewDbMaintenance } from './databaseCleanup.js';

export function buildDatabaseMaintenanceReport(db) {
  const quickCheck = db.pragma('quick_check').map((row) => Object.values(row)[0]);
  const foreignKeyViolations = db.pragma('foreign_key_check');
  const duplicateClusters = findCanonicalDuplicateClusters(db);
  const migrations = getMigrationStatus(db);
  const manualOrphans = manualOrphanCounts(db);
  const duplicates = summarizeCanonicalDuplicates(duplicateClusters);
  return {
    healthy:
      migrations.upToDate &&
      quickCheck.length === 1 &&
      quickCheck[0] === 'ok' &&
      foreignKeyViolations.length === 0 &&
      Object.values(manualOrphans).every((count) => count === 0) &&
      duplicates.duplicatesToMerge === 0,
    migrations,
    integrity: {
      quickCheck,
      foreignKeyViolations: foreignKeyViolations.length,
      manualOrphans,
    },
    listings: {
      total: scalar(db, 'SELECT COUNT(*) FROM listings'),
      withFullText: scalar(db, 'SELECT COUNT(*) FROM listing_texts WHERE length(full_text) > 0'),
      hiddenByReason: groupCounts(
        db,
        `SELECT COALESCE(hidden_reason, 'manual') AS value, COUNT(*) AS count
         FROM listings
         WHERE manually_deleted = 1 OR hidden_reason IS NOT NULL
         GROUP BY 1`,
      ),
    },
    queues: {
      parsing: groupedRows(db, 'SELECT status, stage, COUNT(*) AS count FROM parsing_queue GROUP BY 1,2'),
      detail: groupedRows(db, 'SELECT status, COUNT(*) AS count FROM detail_fetch_queue GROUP BY 1'),
      rating: groupedRows(db, 'SELECT status, COUNT(*) AS count FROM rating_queue GROUP BY 1'),
    },
    duplicates,
    cleanup: previewDbMaintenance(),
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
