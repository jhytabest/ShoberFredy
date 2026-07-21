/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Add the optional LLM-generated notification summary column. Additive and
 * nullable: existing schema-v4 extractions stay valid (no re-parse), and only
 * newly parsed listings populate it.
 */
export function up(db) {
  const columns = db.prepare(`PRAGMA table_info(listing_attributes)`).all();
  if (!columns.some((column) => column.name === 'summary')) {
    db.exec(`ALTER TABLE listing_attributes ADD COLUMN summary TEXT`);
  }
}
