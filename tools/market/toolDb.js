/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Database access for the standalone market tools (model daemon, metrics
 * exporter, geocode backfill). These run as separate processes/containers
 * against the same SQLite file as the main app, so they open their own
 * better-sqlite3 handle instead of going through SqliteConnection.
 *
 * Path resolution: FREDY_MARKET_DB_PATH env var first, then the app's own
 * config (conf/config.json sqlitepath, default /db) + listings.db.
 */

import Database from 'better-sqlite3';
import { computeDbPath } from '../../lib/services/storage/SqliteConnection.js';
import { addressKey } from '../../lib/services/geocoding/address.js';

/**
 * Resolve the listings database path for a tool process.
 * @returns {Promise<string>}
 */
export async function resolveDbPath() {
  if (process.env.FREDY_MARKET_DB_PATH) return process.env.FREDY_MARKET_DB_PATH;
  const { dbPath } = await computeDbPath();
  return dbPath;
}

/**
 * Open the listings database for a tool process with the shared busy timeout
 * and the homeserver_address_key SQL function registered.
 *
 * @param {string} dbPath
 * @param {{readonly?: boolean, fileMustExist?: boolean}} [options]
 * @returns {import('better-sqlite3').Database}
 */
export function openToolDb(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  if (options.readonly) {
    db.pragma('query_only = ON');
  }
  db.pragma('busy_timeout = 30000');
  db.function('homeserver_address_key', { deterministic: true }, addressKey);
  return db;
}
