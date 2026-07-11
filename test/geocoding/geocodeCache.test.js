/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  ensureCacheTable,
  getUsableCache,
  saveCache,
  getCachedAccuracy,
} from '../../lib/services/geocoding/geocodeCache.js';
import { addressKey } from '../../lib/services/geocoding/address.js';

const RETRY_MS = 30 * 24 * 60 * 60 * 1000;

describe('geocodeCache', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureCacheTable(db);
  });

  const okEntry = {
    addressKey: 'torstraße 12, 10119 berlin',
    sourceAddress: 'Torstraße 12, 10119 Berlin',
    status: 'ok',
    latitude: 52.53,
    longitude: 13.4,
    accuracy: 'house',
    placeId: 'abc',
    formattedAddress: 'Torstraße 12, 10119 Berlin, Deutschland',
    error: null,
  };

  it('saves and returns ok entries', () => {
    saveCache(db, okEntry);
    const row = getUsableCache(db, okEntry.addressKey, RETRY_MS);
    expect(row.status).toBe('ok');
    expect(row.latitude).toBe(52.53);
    expect(row.attempts).toBe(1);
  });

  it('bumps attempts on upsert', () => {
    saveCache(db, okEntry);
    saveCache(db, { ...okEntry, latitude: 52.54 });
    const row = getUsableCache(db, okEntry.addressKey, RETRY_MS);
    expect(row.attempts).toBe(2);
    expect(row.latitude).toBe(52.54);
  });

  it('returns failed entries only within the retry window', () => {
    const failed = { ...okEntry, status: 'failed', latitude: null, longitude: null, accuracy: 'failed' };
    saveCache(db, failed);
    expect(getUsableCache(db, okEntry.addressKey, RETRY_MS).status).toBe('failed');
    // Window elapsed → cache miss so the address is retried.
    expect(getUsableCache(db, okEntry.addressKey, -1)).toBe(null);
  });

  it('getCachedAccuracy reads only ok rows', () => {
    saveCache(db, okEntry);
    expect(getCachedAccuracy(db, addressKey, okEntry.sourceAddress)).toBe('house');
    expect(getCachedAccuracy(db, addressKey, 'Unknown Street 1')).toBe(null);
  });
});
