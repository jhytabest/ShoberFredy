/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { sha256 } from '../../../../shared/hash.js';

export function up(db) {
  // Migration 107 retained repaired text with its extraction key in this column.
  // Restore the text fingerprint without changing facts or delivery eligibility.
  const rows = db.prepare(`SELECT t.listing_id,t.full_text FROM listing_texts t
    JOIN listings l ON l.id=t.listing_id WHERE t.content_hash=l.representative_queue_id`).all();
  const update = db.prepare('UPDATE listing_texts SET content_hash=? WHERE listing_id=?');
  for (const row of rows) update.run(sha256(row.full_text),row.listing_id);
}
