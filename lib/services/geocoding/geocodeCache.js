/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Shared homeserver_geocode_cache helpers. The cache is written by the
 * ingestion-time geocoding service (geoCodingService.js) and the backfill
 * CLI (tools/market/geocoderBackfill.js), and read by the market model,
 * scorer, dedupe and exporter. Every reader and writer must go through these
 * helpers so schema and upsert semantics stay identical.
 *
 * The table itself is created by migration 22; ensureCacheTable stays
 * available for standalone tools that may touch a database before the main
 * app has migrated it.
 */

/**
 * Create the geocode cache table when missing (idempotent).
 * @param {import('better-sqlite3').Database} db
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
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

/**
 * Return the cache row for a key when it is still usable: 'ok' rows are
 * always usable, 'failed' rows only until retryFailedAfterMs has elapsed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} key addressKey() of the address
 * @param {number} retryFailedAfterMs
 * @returns {object|null}
 */
export function getUsableCache(db, key, retryFailedAfterMs) {
  const row = db.prepare(`SELECT * FROM homeserver_geocode_cache WHERE address_key = ?`).get(key);
  if (!row) return null;
  if (row.status === 'ok') return row;
  const retryAt = row.updated_at + retryFailedAfterMs;
  return Date.now() < retryAt ? row : null;
}

/**
 * Upsert a cache entry, bumping the attempts counter on conflict.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{addressKey: string, sourceAddress: string, status: string, latitude: number|null,
 *   longitude: number|null, accuracy: string, placeId: string|null,
 *   formattedAddress: string|null, error: string|null}} entry
 */
export function saveCache(db, entry) {
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO homeserver_geocode_cache (
      address_key, source_address, status, latitude, longitude, accuracy,
      place_id, formatted_address, error, attempts, created_at, updated_at
    )
    VALUES (
      @addressKey, @sourceAddress, @status, @latitude, @longitude, @accuracy,
      @placeId, @formattedAddress, @error, 1, @now, @now
    )
    ON CONFLICT(address_key) DO UPDATE SET
      source_address = excluded.source_address,
      status = excluded.status,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      accuracy = excluded.accuracy,
      place_id = excluded.place_id,
      formatted_address = excluded.formatted_address,
      error = excluded.error,
      attempts = homeserver_geocode_cache.attempts + 1,
      updated_at = excluded.updated_at
    `,
  ).run({ ...entry, now });
}

/**
 * Accuracy of the cached geocode for an address ('house', 'street',
 * 'postcode', 'district'), or null when the address is not cached as ok.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {(value: string) => string} keyFn addressKey implementation
 * @param {string} address
 * @returns {string|null}
 */
export function getCachedAccuracy(db, keyFn, address) {
  if (!address) return null;
  const row = db
    .prepare(`SELECT accuracy FROM homeserver_geocode_cache WHERE address_key = ? AND status = 'ok'`)
    .get(keyFn(address));
  return row ? row.accuracy : null;
}
