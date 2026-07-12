/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Trim the database to active data only:
 *
 * - Delete the legacy shadow-job corpus (rows tagged 'legacy_shadow' by
 *   migration 24) and the corresponding "zz Shadow" jobs. The save-all
 *   policy captures the full corpus in the main jobs, the model never
 *   trained on shadow rows, and the cross-portal dedupe never matched them.
 * - Drop the legacy homeserver_backfill_hides audit table (one-off manual
 *   backfill from the pre-Shoberfredy deployment; no code references it).
 *
 * Listing-dependent score, attribute, and model-output rows are cleaned up
 * too. Model outputs are fully rebuilt on every training run.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.exec(`
    CREATE TEMP TABLE legacy_shadow_jobs AS
    SELECT DISTINCT job_id AS id
    FROM listings
    WHERE hidden_reason = 'legacy_shadow';

    DELETE FROM homeserver_listing_scores
    WHERE listing_id IN (SELECT id FROM listings WHERE hidden_reason = 'legacy_shadow');

    DELETE FROM homeserver_listing_market_model
    WHERE listing_id IN (SELECT id FROM listings WHERE hidden_reason = 'legacy_shadow');

    DELETE FROM listing_attributes
    WHERE listing_id IN (SELECT id FROM listings WHERE hidden_reason = 'legacy_shadow');

    DELETE FROM listings WHERE hidden_reason = 'legacy_shadow';

    DELETE FROM jobs
    WHERE id IN (SELECT id FROM legacy_shadow_jobs)
       OR (name LIKE 'zz Shadow%' AND json_array_length(notification_adapter) = 0);

    DROP TABLE legacy_shadow_jobs;

    DROP TABLE IF EXISTS homeserver_backfill_hides;
  `);
}
