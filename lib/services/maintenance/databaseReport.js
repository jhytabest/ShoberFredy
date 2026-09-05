/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { getMigrationStatus } from '../storage/migrations/migrate.js';
import { previewDbMaintenance } from './databaseCleanup.js';

const VERDICT_CONTROL_KEY = 'data_integrity_verdict';

export function buildDatabaseMaintenanceReport(db) {
  const quickCheck = db.pragma('quick_check').map((row) => Object.values(row)[0]);
  const foreignKeyViolations = db.pragma('foreign_key_check');
  const migrations = getMigrationStatus(db);
  const manualOrphans = manualOrphanCounts(db);
  const claims = claimCounts(db);
  return {
    healthy:
      migrations.upToDate &&
      quickCheck.length === 1 &&
      quickCheck[0] === 'ok' &&
      foreignKeyViolations.length === 0 &&
      Object.values(manualOrphans).every((count) => count === 0) &&
      claims.listingsWithoutClaims === 0 &&
      claims.rejectionsWithoutClaims === 0,
    migrations,
    integrity: {
      quickCheck,
      foreignKeyViolations: foreignKeyViolations.length,
      manualOrphans,
    },
    listings: {
      total: scalar(db, 'SELECT COUNT(*) FROM listings'),
      withFullText: scalar(db, 'SELECT COUNT(*) FROM listing_texts WHERE length(full_text) > 0'),
      rejectedByReason: groupCounts(
        db,
        `SELECT reason AS value, COUNT(*) AS count
         FROM listing_verdicts
         WHERE verdict = 'rejected'
         GROUP BY 1`,
      ),
      acceptedSomewhere: scalar(
        db,
        `SELECT COUNT(DISTINCT listing_id) FROM listing_verdicts WHERE verdict = 'accepted'`,
      ),
    },
    rejections: {
      total: scalar(db, 'SELECT COUNT(*) FROM source_rejections'),
      byReason: groupCounts(db, 'SELECT reason AS value, COUNT(*) AS count FROM source_rejections GROUP BY 1'),
      reDecided: scalar(db, 'SELECT COALESCE(SUM(decided_count - 1), 0) FROM source_rejections'),
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
    rejectionsWithoutClaims: scalar(
      db,
      `SELECT COUNT(*) FROM source_rejections rejection
       JOIN listing_sources source ON source.id = rejection.source_id
       WHERE NOT EXISTS (SELECT 1 FROM listing_claims claim WHERE claim.source_id = rejection.source_id)
         AND NOT EXISTS (
           SELECT 1 FROM listing_claims claim
           WHERE claim.claim = 'src:' || source.provider || ':' || source.source_key
         )`,
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

export function recordDataIntegrityVerdict(report, now = Date.now()) {
  SqliteConnection.execute(
    `INSERT INTO pipeline_control (name, value, updated_at) VALUES (@name, @value, @now)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    {
      name: VERDICT_CONTROL_KEY,
      now,
      value: JSON.stringify({
        healthy: report.healthy,
        quickCheck: report.integrity.quickCheck,
        foreignKeyViolations: report.integrity.foreignKeyViolations,
        manualOrphans: report.integrity.manualOrphans,
        listingsWithoutClaims: report.claims.listingsWithoutClaims,
        checkedAt: now,
      }),
    },
  );
}

export function lastDataIntegrityVerdict(db) {
  const row = db.prepare('SELECT value FROM pipeline_control WHERE name = ?').get(VERDICT_CONTROL_KEY);
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
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
