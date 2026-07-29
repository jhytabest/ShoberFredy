/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getMigrationStatus } from '../storage/migrations/migrate.js';
import { previewDbMaintenance } from './databaseCleanup.js';

export function buildDatabaseMaintenanceReport(db) {
  const quickCheck = db.pragma('quick_check').map((row) => Object.values(row)[0]);
  const foreignKeyViolations = db.pragma('foreign_key_check');
  const migrations = getMigrationStatus(db);
  const manualOrphans = manualOrphanCounts(db);
  // Duplicate clustering used to be reported here, computed by a nightly sweep
  // that no longer exists: a listing now resolves against every recorded claim
  // at the moment it is written, so a backlog of duplicates to merge is not a
  // state the database can be in. What is worth watching is whether the claim
  // table is actually being fed — a listing with no claims can never be
  // recognised again, and that is the failure this number would show.
  const claims = claimCounts(db);
  return {
    healthy:
      migrations.upToDate &&
      quickCheck.length === 1 &&
      quickCheck[0] === 'ok' &&
      foreignKeyViolations.length === 0 &&
      Object.values(manualOrphans).every((count) => count === 0) &&
      claims.listingsWithoutClaims === 0,
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
    work: groupedRows(
      db,
      `SELECT kind, status, json_extract(payload_json, '$.stage') AS stage, COUNT(*) AS count
       FROM pipeline_work
       GROUP BY kind, status, stage
       ORDER BY kind, status, stage`,
    ),
    claims,
    cleanup: previewDbMaintenance(),
  };
}

function claimCounts(db) {
  return {
    total: scalar(db, 'SELECT COUNT(*) FROM listing_claims'),
    byKind: groupCounts(db, 'SELECT kind AS value, COUNT(*) AS count FROM listing_claims GROUP BY 1'),
    listingsWithClaims: scalar(db, 'SELECT COUNT(DISTINCT listing_id) FROM listing_claims'),
    listingsWithoutClaims: scalar(
      db,
      `SELECT COUNT(*) FROM listings listing
       WHERE NOT EXISTS (SELECT 1 FROM listing_claims claim WHERE claim.listing_id = listing.id)`,
    ),
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
       LEFT JOIN pipeline_work work ON work.kind = 'parse' AND work.key = audit.queue_id
       WHERE audit.queue_id IS NOT NULL AND work.key IS NULL`,
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
