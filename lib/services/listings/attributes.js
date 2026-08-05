/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { jsonObject, toJson } from '../../shared/json.js';

export function upsertListingAttributes(db, listingId, attributes, parsedAt = Date.now()) {
  db.prepare(
    `INSERT INTO listing_attributes (listing_id, data, parsed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(listing_id) DO UPDATE SET
       data = excluded.data,
       parsed_at = excluded.parsed_at`,
  ).run(listingId, toJson(attributes) ?? '{}', parsedAt);
}

export function listingAttributes(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return jsonObject(value.attributes_json ?? value.data);
  }
  return jsonObject(value);
}
