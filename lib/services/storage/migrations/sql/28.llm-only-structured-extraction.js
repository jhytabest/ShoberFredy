/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * LLM-only structured extraction pipeline:
 * - `listing_attributes` gains the normalized `availability` enum and the
 *   free-text `comments` overflow field for everything that does not fit
 *   the structured schema.
 * - `llm_budget_usage` persists the daily LLM request budget per queue kind
 *   (live/backfill), so restarts never lose track of spent requests.
 * - An index on (job_id, provider, source_hash) makes the hot
 *   known-source check on `parsing_queue` index-backed.
 * - Historical `listing_type` values move from the retired 'apartment'
 *   vocabulary entry to 'rental'.
 */
export function up(db) {
  addColumn(db, 'listing_attributes', 'availability TEXT');
  addColumn(db, 'listing_attributes', 'comments TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_budget_usage (
      day INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('live', 'backfill')),
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_parsing_queue_source
      ON parsing_queue (job_id, provider, source_hash, status);
  `);

  db.prepare("UPDATE listing_attributes SET listing_type = 'rental' WHERE listing_type = 'apartment'").run();
}

function addColumn(db, table, definition) {
  const name = definition.split(/\s+/)[0];
  const exists = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((column) => column.name === name);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}
