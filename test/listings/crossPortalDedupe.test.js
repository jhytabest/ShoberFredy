/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Back SqliteConnection with a shared in-memory database so the dedupe
// module runs against real SQL without touching the filesystem.
let memoryDb;

vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: {
    getConnection: () => memoryDb,
    tableExists: (name) =>
      Boolean(memoryDb.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)),
    query: (sql, params = {}) => memoryDb.prepare(sql).all(params),
    execute: (sql, params = {}) => memoryDb.prepare(sql).run(params),
  },
}));

const deleteListingsById = vi.fn();
vi.mock('../../lib/services/storage/listingsStorage.js', () => ({
  deleteListingsById: (ids) => deleteListingsById(ids),
}));

const { crossPortalDedupe } = await import('../../lib/services/listings/crossPortalDedupe.js');
const { ensureCacheTable, saveCache } = await import('../../lib/services/geocoding/geocodeCache.js');
const { addressKey } = await import('../../lib/services/geocoding/address.js');

function seedSchema(db) {
  db.exec(`
    CREATE TABLE jobs (id TEXT PRIMARY KEY, notification_adapter TEXT);
    CREATE TABLE listings (
      id TEXT PRIMARY KEY, job_id TEXT, provider TEXT, link TEXT, title TEXT,
      price REAL, size REAL, address TEXT, latitude REAL, longitude REAL,
      created_at INTEGER, manually_deleted INTEGER DEFAULT 0
    );
  `);
  ensureCacheTable(db);
}

function insertJob(db, id, notifying) {
  db.prepare(`INSERT INTO jobs (id, notification_adapter) VALUES (?, ?)`).run(
    id,
    JSON.stringify(notifying ? [{ id: 'ntfy' }] : []),
  );
}

function insertListing(db, listing) {
  db.prepare(
    `INSERT INTO listings (id, job_id, provider, link, title, price, size, address, latitude, longitude, created_at, manually_deleted)
     VALUES (@id, @job_id, @provider, @link, @title, @price, @size, @address, @latitude, @longitude, @created_at, @manually_deleted)`,
  ).run({ manually_deleted: 0, latitude: null, longitude: null, ...listing });
}

function cacheGeocode(db, address, accuracy) {
  saveCache(db, {
    addressKey: addressKey(address),
    sourceAddress: address,
    status: 'ok',
    latitude: 52.5,
    longitude: 13.4,
    accuracy,
    placeId: null,
    formattedAddress: address,
    error: null,
  });
}

const NOTIFYING = [{ id: 'ntfy' }];

describe('crossPortalDedupe', () => {
  beforeEach(() => {
    memoryDb = new Database(':memory:');
    seedSchema(memoryDb);
    deleteListingsById.mockClear();
  });

  it('keeps everything for shadow jobs (no adapters)', () => {
    const listings = [{ id: 'a', title: 'x' }];
    expect(crossPortalDedupe(listings, { providerId: 'p', notificationAdapters: [] })).toEqual(listings);
    expect(deleteListingsById).not.toHaveBeenCalled();
  });

  it('suppresses a same-link duplicate with matching size and close price', () => {
    insertJob(memoryDb, 'job1', true);
    insertListing(memoryDb, {
      id: 'old',
      job_id: 'job1',
      provider: 'immoscout',
      link: 'https://example.com/flat-1',
      title: 'Flat',
      price: 1000,
      size: 60,
      address: 'Torstraße 12, 10119 Berlin',
      latitude: 52.5,
      longitude: 13.4,
      created_at: Date.now() - 1000,
    });

    const fresh = {
      id: 'new',
      title: 'Flat again',
      link: 'https://example.com/flat-1',
      price: 1010, // within ±2%
      size: 60,
      address: 'Torstraße 12, 10119 Berlin',
      latitude: 52.5,
      longitude: 13.4,
    };
    const kept = crossPortalDedupe([fresh], { providerId: 'immowelt', notificationAdapters: NOTIFYING });
    expect(kept).toEqual([]);
    expect(deleteListingsById).toHaveBeenCalledWith(['new']);
  });

  it('suppresses a cross-portal duplicate on trusted coordinates', () => {
    insertJob(memoryDb, 'job1', true);
    const address = 'Torstraße 12, 10119 Berlin';
    cacheGeocode(memoryDb, address, 'house');
    insertListing(memoryDb, {
      id: 'old',
      job_id: 'job1',
      provider: 'immoscout',
      link: 'https://portal-a.example/1',
      title: 'Flat',
      price: 1000,
      size: 60,
      address,
      latitude: 52.5,
      longitude: 13.4,
      created_at: Date.now() - 1000,
    });

    const fresh = {
      id: 'new',
      title: 'Same flat elsewhere',
      link: 'https://portal-b.example/99',
      price: 995,
      size: 60,
      address,
      latitude: 52.500004,
      longitude: 13.400004,
    };
    const kept = crossPortalDedupe([fresh], { providerId: 'immowelt', notificationAdapters: NOTIFYING });
    expect(kept).toEqual([]);
  });

  it('keeps listings when the geocode is not trusted', () => {
    insertJob(memoryDb, 'job1', true);
    const address = '10119 Berlin';
    cacheGeocode(memoryDb, address, 'postcode');
    insertListing(memoryDb, {
      id: 'old',
      job_id: 'job1',
      provider: 'immoscout',
      link: 'https://portal-a.example/1',
      title: 'Flat',
      price: 1000,
      size: 60,
      address,
      latitude: 52.5,
      longitude: 13.4,
      created_at: Date.now() - 1000,
    });

    const fresh = {
      id: 'new',
      title: 'Different flat, same postcode centroid',
      link: 'https://portal-b.example/99',
      price: 1000,
      size: 60,
      address,
      latitude: 52.5,
      longitude: 13.4,
    };
    const kept = crossPortalDedupe([fresh], { providerId: 'immowelt', notificationAdapters: NOTIFYING });
    expect(kept).toHaveLength(1);
    expect(deleteListingsById).not.toHaveBeenCalled();
  });

  it('never matches against shadow-job rows', () => {
    insertJob(memoryDb, 'shadow', false);
    insertListing(memoryDb, {
      id: 'old',
      job_id: 'shadow',
      provider: 'immoscout',
      link: 'https://example.com/flat-1',
      title: 'Flat',
      price: 1000,
      size: 60,
      address: 'Torstraße 12, 10119 Berlin',
      latitude: 52.5,
      longitude: 13.4,
      created_at: Date.now() - 1000,
    });

    const fresh = {
      id: 'new',
      title: 'Flat',
      link: 'https://example.com/flat-1',
      price: 1000,
      size: 60,
      address: 'Torstraße 12, 10119 Berlin',
    };
    const kept = crossPortalDedupe([fresh], { providerId: 'immowelt', notificationAdapters: NOTIFYING });
    expect(kept).toHaveLength(1);
  });

  it('requires matching size and close price even for same link', () => {
    insertJob(memoryDb, 'job1', true);
    insertListing(memoryDb, {
      id: 'old',
      job_id: 'job1',
      provider: 'immoscout',
      link: 'https://example.com/flat-1',
      title: 'Flat',
      price: 1000,
      size: 60,
      address: 'Torstraße 12, 10119 Berlin',
      created_at: Date.now() - 1000,
    });

    const repriced = {
      id: 'new',
      title: 'Flat repriced',
      link: 'https://example.com/flat-1',
      price: 900, // -10% → repricing event, must be re-notified
      size: 60,
      address: 'Torstraße 12, 10119 Berlin',
    };
    const kept = crossPortalDedupe([repriced], { providerId: 'immoscout', notificationAdapters: NOTIFYING });
    expect(kept).toHaveLength(1);
  });
});
