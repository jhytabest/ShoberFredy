/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import SqliteConnection from './SqliteConnection.js';

/**
 * Keep one authoritative full-text capture per canonical listing. When several
 * sources converge, retain the richest text rather than duplicating every
 * queue payload indefinitely.
 */
export function saveListingText(listingId, fullText, capturedAt = Date.now(), db = SqliteConnection.getConnection()) {
  const text = typeof fullText === 'string' ? fullText.trim() : '';
  if (!listingId || !text) return;
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  db.prepare(
    `INSERT INTO listing_texts (listing_id, full_text, content_hash, captured_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(listing_id) DO UPDATE SET
       full_text = CASE WHEN LENGTH(excluded.full_text) > LENGTH(full_text) THEN excluded.full_text ELSE full_text END,
       content_hash = CASE WHEN LENGTH(excluded.full_text) > LENGTH(full_text) THEN excluded.content_hash ELSE content_hash END,
       captured_at = CASE WHEN LENGTH(excluded.full_text) > LENGTH(full_text) THEN excluded.captured_at ELSE captured_at END`,
  ).run(listingId, text, hash, capturedAt);
}
