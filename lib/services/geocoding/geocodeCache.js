/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export function ensureCacheTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS homeserver_geocode_cache (
      address_key TEXT PRIMARY KEY,
      source_address TEXT NOT NULL,
      status TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      accuracy TEXT NOT NULL,
      place_id TEXT,
      formatted_address TEXT,
      locality TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

export const COARSE_ACCURACY = new Set(['postcode', 'district']);

export function getCacheRow(db, key) {
  return db.prepare(`SELECT * FROM homeserver_geocode_cache WHERE address_key = ?`).get(key) || null;
}

export function getUsableCache(db, key, retryFailedAfterMs, retryCoarseAfterMs = Number.POSITIVE_INFINITY) {
  const row = getCacheRow(db, key);
  if (!row) return null;
  if (row.status === 'ok') {
    if (!COARSE_ACCURACY.has(row.accuracy)) return row;
    return Date.now() < row.updated_at + retryCoarseAfterMs ? row : null;
  }
  const retryAt = row.updated_at + retryFailedAfterMs;
  return Date.now() < retryAt ? row : null;
}

export function saveCache(db, entry) {
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO homeserver_geocode_cache (
      address_key, source_address, status, latitude, longitude, accuracy,
      place_id, formatted_address, locality, error, attempts, created_at, updated_at
    )
    VALUES (
      @addressKey, @sourceAddress, @status, @latitude, @longitude, @accuracy,
      @placeId, @formattedAddress, @locality, @error, 1, @now, @now
    )
    ON CONFLICT(address_key) DO UPDATE SET
      source_address = excluded.source_address,
      status = excluded.status,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      accuracy = excluded.accuracy,
      place_id = excluded.place_id,
      formatted_address = excluded.formatted_address,
      locality = excluded.locality,
      error = excluded.error,
      attempts = homeserver_geocode_cache.attempts + 1,
      updated_at = excluded.updated_at
    `,
  ).run({ ...entry, now });
}

export function getCachedAccuracy(db, keyFn, address, city) {
  if (!address) return null;
  const row = db
    .prepare(`SELECT accuracy FROM homeserver_geocode_cache WHERE address_key = ? AND status = 'ok'`)
    .get(keyFn(address, city));
  return row ? row.accuracy : null;
}
