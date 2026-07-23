/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

// Remove persisted state for features that no longer exist in the single-user,
// Telegram-only application.
export function up(db) {
  db.exec(`
    DROP TABLE IF EXISTS watch_list;
    DROP TABLE IF EXISTS debug_logs;
  `);

  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  if (userColumns.some(({ name }) => name === 'mcp_token')) {
    db.exec('ALTER TABLE users DROP COLUMN mcp_token');
  }

  const jobColumns = db.prepare('PRAGMA table_info(jobs)').all();
  if (jobColumns.some(({ name }) => name === 'shared_with_user')) {
    db.exec('ALTER TABLE jobs DROP COLUMN shared_with_user');
  }
}
