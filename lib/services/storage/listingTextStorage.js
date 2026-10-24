/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import SqliteConnection from './SqliteConnection.js';

export function saveListingText(listingId, fullText, capturedAt = Date.now(), db = SqliteConnection.getConnection()) {
  const text = typeof fullText === 'string' ? fullText.trim() : '';
  if (!listingId || !text) return;
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  db.prepare(
    `INSERT INTO listing_texts (listing_id, full_text, content_hash, captured_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(listing_id) DO UPDATE SET
       full_text = excluded.full_text,
       content_hash = excluded.content_hash,
       captured_at = excluded.captured_at`,
  ).run(listingId, text, hash, capturedAt);
}
