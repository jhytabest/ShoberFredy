/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Database access for the market services (model retraining, metrics
 * exporter). They open their own better-sqlite3 handle
 * instead of going through SqliteConnection: the exporter wants a read-only
 * handle, and the model registers a SQL UDF as its
 * own process — WAL + busy_timeout make the handles coexist.
 *
 * Path resolution: FREDY_MARKET_DB_PATH env var first, then the app's own
 * config (conf/config.json sqlitepath, default /db) + listings.db.
 */

import Database from 'better-sqlite3';
import { env, envIsSet } from '../../shared/env.js';
import { computeDbPath } from '../storage/SqliteConnection.js';
import { addressKey } from '../geocoding/address.js';

/**
 * Resolve the listings database path for a market service.
 * @returns {Promise<string>}
 */
export async function resolveDbPath() {
  if (envIsSet('FREDY_MARKET_DB_PATH')) return env('FREDY_MARKET_DB_PATH');
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
