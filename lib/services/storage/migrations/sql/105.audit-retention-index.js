/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export function up(db) {
  // The old partial index excludes rows the retention query must also remove.
  // IF NOT EXISTS accepts the same index installed during online backlog cleanup.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_payload_retention ON audit_payloads(expires_at);
    DROP INDEX IF EXISTS idx_audit_payload_expiry;
  `);
}
