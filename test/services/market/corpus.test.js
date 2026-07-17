/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { loadCorpus, coldEquivalentRent, weightFor } from '../../../lib/services/market/corpus.js';
import { addressKey } from '../../../lib/services/geocoding/address.js';

describe('coldEquivalentRent', () => {
  it('prefers parsed Kaltmiete', () => {
    expect(coldEquivalentRent({ coldRentEur: 900 }, 1100)).toEqual({ rent: 900, type: 'cold' });
  });

  it('uses the price when the provider declares it cold', () => {
    expect(coldEquivalentRent({ priceType: 'cold' }, 1000)).toEqual({ rent: 1000, type: 'cold' });
  });

  it('imputes cold from warm minus charges', () => {
    const result = coldEquivalentRent({ priceType: 'warm', serviceChargesEur: 200, heatingCostsEur: 80 }, 1280);
    expect(result.type).toBe('cold_est');
    expect(result.rent).toBe(1000);
  });

  it('rejects implausible imputations (charges parsed wrong)', () => {
    const result = coldEquivalentRent({ priceType: 'warm', serviceChargesEur: 900 }, 1000);
    expect(result.rent).toBeNull();
    expect(result.type).toBe('warm');
  });

  it('warm without breakdown and unknown are not trainable', () => {
    expect(coldEquivalentRent({ priceType: 'warm' }, 1200).rent).toBeNull();
    expect(coldEquivalentRent({ priceType: 'unknown' }, 1200)).toEqual({ rent: null, type: 'unknown' });
  });
});

describe('weightFor', () => {
  it('halves at the half-life and floors at the minimum', () => {
    expect(weightFor(0, 90)).toBe(1);
    expect(weightFor(90, 90)).toBeCloseTo(0.5, 10);
    expect(weightFor(100000, 90)).toBe(0.05);
    expect(weightFor(50, 0)).toBe(1);
  });
});

describe('loadCorpus', () => {
  let db;
  const NOW = 1750000000000;

  const insertListing = (row) => {
    db.prepare(
      `INSERT INTO listings (id, created_at, price, size, rooms, title, description, address, link, provider,
                             job_id, latitude, longitude, manually_deleted, hidden_reason)
       VALUES (@id, @created_at, @price, @size, @rooms, @title, @description, @address, @link, @provider,
               @job_id, @latitude, @longitude, @manually_deleted, @hidden_reason)`,
    ).run({
      created_at: NOW - 10 * 24 * 60 * 60 * 1000,
      rooms: 2,
      title: 'Wohnung',
      description: '',
      address: 'Teststr. 1, 10999 Berlin',
      link: `https://portal/${row.id}`,
      provider: 'immoscout',
      job_id: 'job-main',
      latitude: 52.5,
      longitude: 13.4,
      manually_deleted: 0,
      hidden_reason: null,
      price: 1000,
      size: 70,
      ...row,
    });
    db.prepare(
      `INSERT OR REPLACE INTO listing_attributes (listing_id, price_type, swap, parsed_at, features_json)
       VALUES (@listingId, @priceType, @swap, @parsedAt, '{}')`,
    ).run({ listingId: row.id, priceType: row.attr_price_type ?? 'cold', swap: row.attr_swap ?? 0, parsedAt: NOW });
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.function('homeserver_address_key', { deterministic: true }, addressKey);
    db.exec(`
      CREATE TABLE jobs (id TEXT PRIMARY KEY, notification_adapter TEXT);
      CREATE TABLE listings (
        id TEXT PRIMARY KEY, created_at INTEGER, price REAL, size REAL, rooms REAL,
        title TEXT, description TEXT, address TEXT, link TEXT, provider TEXT, job_id TEXT,
        latitude REAL, longitude REAL, manually_deleted INTEGER DEFAULT 0, hidden_reason TEXT
      );
      CREATE TABLE listing_attributes (
        listing_id TEXT PRIMARY KEY, cold_rent_eur REAL, warm_rent_eur REAL, service_charges_eur REAL,
        heating_costs_eur REAL, deposit_eur REAL, price_type TEXT, rooms REAL, floor INTEGER,
        building_year INTEGER, property_type TEXT, energy_class TEXT, pets_allowed INTEGER,
        available_from TEXT, swap INTEGER DEFAULT 0, features_json TEXT, parsed_at INTEGER
      );
      CREATE TABLE homeserver_geocode_cache (
        address_key TEXT PRIMARY KEY, source_address TEXT, status TEXT, latitude REAL, longitude REAL,
        accuracy TEXT, place_id TEXT, formatted_address TEXT, error TEXT, attempts INTEGER,
        created_at INTEGER, updated_at INTEGER
      );
    `);
    db.prepare(`INSERT INTO jobs VALUES ('job-main', '["telegram"]'), ('job-silent', '[]')`).run();
    db.prepare(
      `INSERT INTO homeserver_geocode_cache (address_key, source_address, status, accuracy, attempts, created_at, updated_at)
       VALUES (?, 'Teststr. 1, 10999 Berlin', 'ok', 'house', 1, 1, 1)`,
    ).run(addressKey('Teststr. 1, 10999 Berlin'));
  });

  it('keeps visible + spec-hidden rows, drops blacklist/swap/non-notifying rows', () => {
    // Distinct coordinates per row so the cross-portal dedupe stays out of
    // this test's way.
    insertListing({ id: 'visible' });
    insertListing({
      id: 'spec-hidden',
      hidden_reason: 'spec_filter',
      manually_deleted: 1,
      link: 'https://p/s1',
      latitude: 52.51,
    });
    insertListing({
      id: 'blacklisted',
      hidden_reason: 'blacklist',
      manually_deleted: 1,
      link: 'https://p/s2',
      latitude: 52.52,
    });
    insertListing({ id: 'swapper', attr_swap: 1, link: 'https://p/s3', latitude: 52.53 });
    insertListing({ id: 'silent', job_id: 'job-silent', link: 'https://p/s4', latitude: 52.54 });

    const corpus = loadCorpus(db, NOW);
    const ids = corpus.rows.map((row) => row.id).sort();
    expect(ids).toEqual(['spec-hidden', 'visible']);
    expect(corpus.stats.swapExcluded).toBe(1);
  });

  it('collapses same-link duplicates to the newest version', () => {
    insertListing({ id: 'old', link: 'https://p/same', created_at: NOW - 20 * 86400000, price: 900 });
    insertListing({ id: 'new', link: 'https://p/same', created_at: NOW - 1 * 86400000, price: 950 });
    const corpus = loadCorpus(db, NOW);
    expect(corpus.rows).toHaveLength(1);
    expect(corpus.rows[0].id).toBe('new');
  });

  it('collapses cross-portal duplicates at the same trusted point and shares clusterId otherwise', () => {
    insertListing({ id: 'a', link: 'https://p/a', price: 1000 });
    insertListing({ id: 'b', link: 'https://q/b', price: 1010 }); // ±2% → duplicate
    insertListing({ id: 'c', link: 'https://r/c', price: 1300 }); // price edit → kept, same cluster
    const corpus = loadCorpus(db, NOW);
    expect(corpus.rows).toHaveLength(2);
    const [first, second] = corpus.rows;
    expect(first.clusterId).toBe(second.clusterId);
    expect(first.clusterId).not.toMatch(/^solo:/);
  });

  it('keeps rows without coordinates as scoreable and trainable (tier missing)', () => {
    insertListing({ id: 'nocoords', latitude: null, longitude: null, link: 'https://p/n1' });
    const corpus = loadCorpus(db, NOW);
    const row = corpus.rows.find((r) => r.id === 'nocoords');
    expect(row.hasCoords).toBe(false);
    expect(row.tier).toBe('missing');
    expect(Number.isNaN(row.x)).toBe(true);
    expect(corpus.trainingRows.some((r) => r.id === 'nocoords')).toBe(true);
  });

  it('excludes unknown price types from training but keeps them scoreable', () => {
    insertListing({ id: 'known', link: 'https://p/k1' });
    // Different point + price so it does not collapse as a cross-portal dup.
    insertListing({ id: 'mystery', attr_price_type: 'unknown', link: 'https://p/m1', latitude: 52.51, price: 1500 });
    const corpus = loadCorpus(db, NOW);
    expect(corpus.rows.map((r) => r.id).sort()).toEqual(['known', 'mystery']);
    expect(corpus.trainingRows.map((r) => r.id)).toEqual(['known']);
    expect(corpus.stats.unknownPriceType).toBe(1);
    expect(corpus.rows.find((r) => r.id === 'mystery').logPricePerSqm).toBeNull();
  });

  it('trims MAD outliers from training only', () => {
    for (let i = 0; i < 30; i += 1) {
      insertListing({ id: `n${i}`, link: `https://p/n${i}`, price: 980 + i, latitude: 52.5 + i * 0.001 });
    }
    insertListing({ id: 'crazy', link: 'https://p/crazy', price: 25000 });
    const corpus = loadCorpus(db, NOW);
    expect(corpus.rows.some((r) => r.id === 'crazy')).toBe(true);
    expect(corpus.trainingRows.some((r) => r.id === 'crazy')).toBe(false);
    expect(corpus.stats.outlierExcluded).toBe(1);
  });

  it('derives the projection reference latitude from the data', () => {
    insertListing({ id: 'south', latitude: 48.1, longitude: 11.5, link: 'https://p/s' });
    insertListing({ id: 'south2', latitude: 48.2, longitude: 11.6, link: 'https://p/s2' });
    insertListing({ id: 'south3', latitude: 48.3, longitude: 11.7, link: 'https://p/s3' });
    const corpus = loadCorpus(db, NOW);
    expect(corpus.stats.referenceLatitude).toBeGreaterThan(48);
    expect(corpus.stats.referenceLatitude).toBeLessThan(48.4);
  });
});
