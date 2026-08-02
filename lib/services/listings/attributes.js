/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { jsonObject, toJson } from '../../shared/json.js';

/**
 * Persist the validated canonical attribute document without restating its
 * fields. The LLM schema and canonical builder own the shape; storage only owns
 * serialization.
 *
 * There is no `schema_version`. The column existed, was written on every upsert
 * and was never read to branch on — nothing adapted an older document, so it
 * recorded a version that could not have differed. Every stored document is
 * migrated to the current shape in place instead, which is the same guarantee
 * without a column to consult.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} listingId
 * @param {object} attributes
 * @param {number} [parsedAt]
 */
export function upsertListingAttributes(db, listingId, attributes, parsedAt = Date.now()) {
  db.prepare(
    `INSERT INTO listing_attributes (listing_id, data, parsed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(listing_id) DO UPDATE SET
       data = excluded.data,
       parsed_at = excluded.parsed_at`,
  ).run(listingId, toJson(attributes) ?? '{}', parsedAt);
}

/**
 * Read a canonical attribute document from either its JSON column or a row
 * carrying that column.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function listingAttributes(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return jsonObject(value.attributes_json ?? value.data);
  }
  return jsonObject(value);
}
