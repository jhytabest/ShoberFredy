/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The legacy deployment auto-hid shadow-job listings with a hand-created DB
 * trigger that hardcoded three job ids. The pipeline now does this natively
 * for every job without notification adapters
 * (FredyPipelineExecutioner._hideShadowJobListings), so the trigger is
 * dropped on databases migrated from that deployment.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.exec(`DROP TRIGGER IF EXISTS shadow_jobs_soft_hide_after_insert;`);
}
