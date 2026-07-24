/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Historical rows which pre-date the durable pipeline are not production
 * listings. Keep their complete audit bundles in compressed archive tables,
 * separate from the live listings/queue graph. Ordinary live filter rejects
 * remain in the production tables and are deliberately unaffected.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pre_llm_archive_runs (
      id TEXT PRIMARY KEY,
      contract_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      archived_count INTEGER NOT NULL DEFAULT 0,
      migrated_count INTEGER NOT NULL DEFAULT 0,
      repaired_count INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT NOT NULL DEFAULT '{}',
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS pre_llm_archive_listings (
      listing_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      archive_version INTEGER NOT NULL,
      reason TEXT NOT NULL,
      geo_state TEXT,
      geo_precision TEXT,
      classification_json TEXT NOT NULL,
      payload_gzip BLOB NOT NULL,
      payload_sha256 TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      compressed_bytes INTEGER NOT NULL,
      archived_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES pre_llm_archive_runs (id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_pre_llm_archive_reason
      ON pre_llm_archive_listings (reason, archived_at);
    CREATE INDEX IF NOT EXISTS idx_pre_llm_archive_run
      ON pre_llm_archive_listings (run_id, archived_at);

    CREATE TABLE IF NOT EXISTS canonical_merge_archive (
      duplicate_listing_id TEXT PRIMARY KEY,
      representative_listing_id TEXT NOT NULL,
      match_tier TEXT NOT NULL,
      match_evidence_json TEXT NOT NULL,
      payload_gzip BLOB NOT NULL,
      payload_sha256 TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      compressed_bytes INTEGER NOT NULL,
      merged_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_canonical_merge_representative
      ON canonical_merge_archive (representative_listing_id, merged_at);
  `);
}
