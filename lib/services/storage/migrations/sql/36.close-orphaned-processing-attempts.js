/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Close historical attempt rows whose durable queue item is no longer running. */
export function up(db) {
  const closedTerminal = db
    .prepare(
      `UPDATE processing_attempts
       SET status = COALESCE(
         (SELECT q.status FROM parsing_queue q WHERE q.id = processing_attempts.queue_id),
         'interrupted'
       )
       WHERE status = 'started'
         AND NOT EXISTS (
           SELECT 1 FROM parsing_queue q
           WHERE q.id = processing_attempts.queue_id AND q.status = 'processing'
         )`,
    )
    .run().changes;

  const closedSuperseded = db
    .prepare(
      `UPDATE processing_attempts
       SET status = 'interrupted'
       WHERE status = 'started'
         AND id NOT IN (
           SELECT MAX(a.id)
           FROM processing_attempts a
           JOIN parsing_queue q ON q.id = a.queue_id AND q.status = 'processing'
           WHERE a.status = 'started'
           GROUP BY a.queue_id
         )`,
    )
    .run().changes;

  db.prepare(
    `INSERT INTO pipeline_audit_events (
       source_id, listing_id, queue_id, stage, action, reason, payload_json, created_at
     ) VALUES (NULL, NULL, NULL, 'migration_repair', 'processing_attempts_closed',
       'Closed stale processing-attempt audit rows', ?, ?)`,
  ).run(JSON.stringify({ closedTerminal, closedSuperseded }), Date.now());
}
