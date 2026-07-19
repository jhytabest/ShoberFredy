/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Preserve the pre-v4 semantic columns for audit, then repair every completed
 * backfill through the normal LLM-only finalizer. The extraction response is
 * already cached, so this repair makes no additional LLM call.
 */
export function up(db) {
  const now = Date.now();

  addColumn(db, 'listings', 'legacy_snapshot_json TEXT');
  addColumn(db, 'listings', 'canonical_schema_version INTEGER NOT NULL DEFAULT 0');

  db.prepare(
    `UPDATE listings
     SET legacy_snapshot_json = json_object(
       'title', title,
       'address', address,
       'price', price,
       'size', size,
       'rooms', rooms,
       'latitude', latitude,
       'longitude', longitude,
       'captured_at', ?
     )
     WHERE legacy_snapshot_json IS NULL`,
  ).run(now);

  // Live schema-v4 rows were already written exclusively from the validated
  // extraction. Mark them without replaying their notification side effects.
  db.prepare(
    `UPDATE listings
     SET canonical_schema_version = 4
     WHERE EXISTS (
       SELECT 1
       FROM parsing_queue q
       JOIN listing_extractions e ON e.queue_id = q.id
       WHERE q.listing_id = listings.id
         AND q.queue_kind = 'live'
         AND q.schema_version = 4
         AND q.status = 'completed'
         AND e.llm_json IS NOT NULL
     )`,
  ).run();

  // Re-run only finalization for historical backfills. parserWorker sees the
  // cached llm_json and therefore does not spend or issue another LLM request.
  db.prepare(
    `UPDATE parsing_queue
     SET stage = 'llm', status = 'pending', lease_until = NULL,
         next_attempt_at = 0, last_error = NULL, completed_at = NULL,
         updated_at = ?
     WHERE queue_kind = 'backfill'
       AND schema_version = 4
       AND status = 'completed'
       AND listing_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM listing_extractions e
         WHERE e.queue_id = parsing_queue.id AND e.llm_json IS NOT NULL
       )`,
  ).run(now);

  // Calls left open by a stopped process are immutable audit history, not
  // active requests. Closing them also makes the live health counters honest.
  db.prepare(
    `UPDATE llm_call_audit
     SET outcome = 'aborted_restart',
         error = COALESCE(error, 'Process ended before the LLM response was recorded'),
         completed_at = ?
     WHERE outcome = 'started'`,
  ).run(now);

  // Pre-v4 deliveries are deliberately not eligible for sending and otherwise
  // remain pending forever. Cancel the stale intent; the listings remain.
  db.prepare(
    `UPDATE notification_deliveries
     SET status = 'cancelled',
         last_error = 'Superseded by the schema-v4 notification pipeline'
     WHERE status = 'pending'
       AND NOT EXISTS (
         SELECT 1 FROM listing_attributes a
         WHERE a.listing_id = notification_deliveries.listing_id
           AND a.schema_version >= 4
       )`,
  ).run();
}

function addColumn(db, table, definition) {
  const name = definition.split(/\s+/)[0];
  if (
    !db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((column) => column.name === name)
  ) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}
