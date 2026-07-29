/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { jsonObject, toJson } from '../../shared/json.js';

export const LISTING_ATTRIBUTE_SCHEMA_VERSION = 4;

/**
 * Persist the validated canonical attribute document without restating its
 * fields. The LLM schema and canonical builder own the shape; storage only owns
 * serialization.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} listingId
 * @param {object} attributes
 * @param {number} [parsedAt]
 */
export function upsertListingAttributes(db, listingId, attributes, parsedAt = Date.now()) {
  db.prepare(
    `INSERT INTO listing_attributes (listing_id, data, schema_version, parsed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(listing_id) DO UPDATE SET
       data = excluded.data,
       schema_version = excluded.schema_version,
       parsed_at = excluded.parsed_at`,
  ).run(listingId, toJson(attributes) ?? '{}', LISTING_ATTRIBUTE_SCHEMA_VERSION, parsedAt);
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
