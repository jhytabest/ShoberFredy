/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Database from 'better-sqlite3';
import { env, envIsSet } from '../../shared/env.js';
import { computeDbPath } from '../storage/SqliteConnection.js';
import { addressKey } from '../geocoding/address.js';

export async function resolveDbPath() {
  if (envIsSet('FREDY_MARKET_DB_PATH')) return env('FREDY_MARKET_DB_PATH');
  const { dbPath } = await computeDbPath();
  return dbPath;
}

export function openToolDb(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  if (options.readonly) {
    db.pragma('query_only = ON');
  }
  db.pragma('busy_timeout = 30000');
  db.function('homeserver_address_key', { deterministic: true }, addressKey);
  return db;
}
