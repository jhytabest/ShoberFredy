/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Google geocode backfill CLI for listings that entered the database without
 * valid coordinates (e.g. during a Google outage window). Shares the
 * homeserver_geocode_cache table and the address key with the ingestion-time
 * geocoding service.
 *
 * Usage: node tools/market/geocoderBackfill.js [run|daemon|status|refresh-all]
 * Env: GOOGLE_GEOCODING_API_KEY (required except status), FREDY_MARKET_DB_PATH,
 *      FREDY_GEOCODER_INTERVAL_SECONDS, FREDY_GEOCODER_BATCH_SIZE,
 *      FREDY_GEOCODER_DELAY_MS, FREDY_GEOCODER_RETRY_FAILED_AFTER_DAYS
 */

import { addressKey } from '../../lib/services/geocoding/address.js';
import { geocodeAddress, GeocodeUnavailableError } from '../../lib/services/geocoding/client/googleClient.js';
import { ensureCacheTable, getUsableCache, saveCache } from '../../lib/services/geocoding/geocodeCache.js';
import { resolveDbPath, openToolDb } from '../../lib/services/market/marketDb.js';

const config = {
  dbPath: process.env.FREDY_GEOCODER_DB_PATH || (await resolveDbPath()),
  intervalSeconds: intEnv('FREDY_GEOCODER_INTERVAL_SECONDS', 6 * 60 * 60),
  batchSize: intEnv('FREDY_GEOCODER_BATCH_SIZE', 250),
  delayMs: intEnv('FREDY_GEOCODER_DELAY_MS', 150),
  retryFailedAfterDays: intEnv('FREDY_GEOCODER_RETRY_FAILED_AFTER_DAYS', 30),
};

const db = openToolDb(config.dbPath);

ensureCacheTable(db);

const mode = process.argv[2] || 'run';

if (mode === 'status') {
  printStatus();
} else if (mode === 'daemon') {
  mustGetEnv('GOOGLE_GEOCODING_API_KEY');
  await runDaemon();
} else if (mode === 'run') {
  mustGetEnv('GOOGLE_GEOCODING_API_KEY');
  await runOnce();
} else if (mode === 'refresh-all') {
  mustGetEnv('GOOGLE_GEOCODING_API_KEY');
  await runOnce({ includeExistingCoordinates: true, replaceExistingCoordinates: true });
} else {
  throw new Error(`Unknown mode: ${mode}`);
}

async function runDaemon() {
  while (true) {
    let delayMs = config.intervalSeconds * 1000;
    try {
      await runOnce();
    } catch (error) {
      console.error(`geocoder run failed, retrying later: ${error.message}`);
      delayMs = Math.min(delayMs, 15 * 60 * 1000);
    }
    await sleep(delayMs);
  }
}

async function runOnce(options = {}) {
  const includeExistingCoordinates = options.includeExistingCoordinates || false;
  const replaceExistingCoordinates = options.replaceExistingCoordinates || false;
  const startedAt = new Date();
  const listings = getListingsToGeocode(
    includeExistingCoordinates ? null : config.batchSize,
    includeExistingCoordinates,
  );
  const seen = new Set();
  const addresses = listings.filter((row) => {
    const key = addressKey(row.address);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const summary = {
    startedAt: startedAt.toISOString(),
    rows: listings.length,
    addresses: addresses.length,
    includeExistingCoordinates,
    replaceExistingCoordinates,
    cached: 0,
    geocoded: 0,
    failed: 0,
    updatedRows: 0,
    skippedRecentFailures: 0,
  };

  for (const listing of addresses) {
    const key = addressKey(listing.address);
    const cached = getUsableCache(db, key, config.retryFailedAfterDays * 24 * 60 * 60 * 1000);

    if (cached?.status === 'ok') {
      summary.cached += 1;
      summary.updatedRows += updateListingsForAddress(
        listing.address,
        cached.latitude,
        cached.longitude,
        replaceExistingCoordinates,
      );
      continue;
    }

    if (cached?.status === 'failed') {
      summary.skippedRecentFailures += 1;
      continue;
    }

    let result;
    try {
      result = await geocodeAddress(listing.address);
    } catch (error) {
      summary.aborted = error.message;
      const kind = error instanceof GeocodeUnavailableError ? 'Google unavailable' : 'unexpected error';
      console.error(`aborting geocoding batch (${kind}): ${error.message}`);
      break;
    }
    if (result) {
      saveCache(db, {
        addressKey: key,
        sourceAddress: listing.address,
        status: 'ok',
        latitude: result.lat,
        longitude: result.lng,
        accuracy: result.accuracy,
        placeId: result.placeId,
        formattedAddress: result.formattedAddress,
        error: null,
      });
      summary.geocoded += 1;
      summary.updatedRows += updateListingsForAddress(
        listing.address,
        result.lat,
        result.lng,
        replaceExistingCoordinates,
      );
    } else {
      saveCache(db, {
        addressKey: key,
        sourceAddress: listing.address,
        status: 'failed',
        latitude: null,
        longitude: null,
        accuracy: 'failed',
        placeId: null,
        formattedAddress: null,
        error: 'No acceptable Google geocoding result',
      });
      summary.failed += 1;
    }
    await sleep(config.delayMs);
  }

  console.log(JSON.stringify(summary));
}

function printStatus() {
  const rows = db
    .prepare(
      `
      WITH classified AS (
        SELECT
          CASE
            WHEN COALESCE(manually_deleted, 0) = 1 THEN 'hidden_deleted'
            WHEN COALESCE(is_active, 0) = 1 THEN 'visible_active'
            ELSE 'visible_inactive'
          END AS bucket,
          address IS NOT NULL AND trim(address) <> '' AS has_address,
          latitude IS NOT NULL AND longitude IS NOT NULL AND latitude != -1 AND longitude != -1 AS has_valid_coords,
          latitude IS NULL OR longitude IS NULL AS has_null_coords,
          latitude = -1 OR longitude = -1 AS has_failed_coords
        FROM listings
      )
      SELECT
        bucket,
        count(*) AS listings,
        sum(has_address) AS with_address,
        sum(has_valid_coords) AS valid_coords,
        sum(has_null_coords) AS null_coords,
        sum(has_failed_coords) AS failed_coords
      FROM classified
      GROUP BY bucket
      ORDER BY bucket
      `,
    )
    .all();
  console.log(JSON.stringify(rows, null, 2));
}

function getListingsToGeocode(limit, includeExistingCoordinates = false) {
  const coordinateFilter = includeExistingCoordinates
    ? ''
    : `
        AND (
          latitude IS NULL
          OR longitude IS NULL
          OR latitude = -1
          OR longitude = -1
        )
      `;
  const limitClause = limit === null ? '' : 'LIMIT @limit';
  const failedCutoff = Date.now() - config.retryFailedAfterDays * 24 * 60 * 60 * 1000;
  const params = { failedCutoff };
  if (limit !== null) params.limit = limit;
  return db
    .prepare(
      `
      SELECT id, address
      FROM listings
      WHERE address IS NOT NULL
        AND trim(address) <> ''
        ${coordinateFilter}
        AND NOT EXISTS (
          SELECT 1 FROM homeserver_geocode_cache c
          WHERE c.address_key = homeserver_address_key(address)
            AND c.status = 'failed'
            AND c.updated_at > @failedCutoff
        )
      ORDER BY
        COALESCE(manually_deleted, 0) ASC,
        COALESCE(is_active, 0) DESC,
        created_at DESC
      ${limitClause}
      `,
    )
    .all(params);
}

function updateListingsForAddress(address, latitude, longitude, replaceExistingCoordinates = false) {
  const key = addressKey(address);
  const coordinateFilter = replaceExistingCoordinates
    ? ''
    : `
        AND (
          latitude IS NULL
          OR longitude IS NULL
          OR latitude = -1
          OR longitude = -1
        )
      `;
  // Resolve ids with a read-only scan first so the address-key UDF never
  // runs inside a write transaction (it would hold the WAL write lock for a
  // full table scan and starve the main app's own inserts).
  const ids = db
    .prepare(
      `
      SELECT id
      FROM listings
      WHERE homeserver_address_key(address) = @addressKey
        ${coordinateFilter}
      `,
    )
    .all({ addressKey: key })
    .map((row) => row.id);
  if (ids.length === 0) return 0;

  const update = db.prepare('UPDATE listings SET latitude = @latitude, longitude = @longitude WHERE id = @id');
  const apply = db.transaction((listingIds) => {
    let changes = 0;
    for (const id of listingIds) {
      changes += update.run({ id, latitude, longitude }).changes;
    }
    return changes;
  });
  return apply(ids);
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function mustGetEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
