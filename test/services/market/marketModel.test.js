/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * End-to-end orchestrator run against a scratch database: seeds a synthetic
 * market, retrains, and asserts every persistence surface (registry, runs,
 * batch scores, surface cells, geojson). The GBM family is pointed at a
 * nonexistent python binary on purpose — its failure must be contained and
 * the ridge family must land regardless.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initMarketModel, runMarketModelOnce, getMarketModelStatus } from '../../../lib/services/market/marketModel.js';
import { addressKey } from '../../../lib/services/geocoding/address.js';
import { rng } from './syntheticCorpus.js';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fredy-model-test-'));
const dbPath = path.join(workDir, 'listings.db');
const NOW = Date.now();

function seed(db) {
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
  db.prepare(`INSERT INTO jobs VALUES ('job-main', '["telegram"]')`).run();

  const random = rng(2024);
  const insertListing = db.prepare(
    `INSERT INTO listings (id, created_at, price, size, rooms, title, description, address, link, provider,
                           job_id, latitude, longitude, manually_deleted, hidden_reason)
     VALUES (@id, @createdAt, @price, @size, 2, 'Wohnung', '', @address, @link, 'immoscout',
             'job-main', @latitude, @longitude, 0, NULL)`,
  );
  const insertAttrs = db.prepare(
    `INSERT INTO listing_attributes (listing_id, price_type, swap, parsed_at, features_json)
     VALUES (@listingId, 'cold', 0, @parsedAt, '{}')`,
  );
  const insertGeo = db.prepare(
    `INSERT OR IGNORE INTO homeserver_geocode_cache (address_key, source_address, status, accuracy, attempts, created_at, updated_at)
     VALUES (@key, @address, 'ok', 'house', 1, 1, 1)`,
  );
  for (let i = 0; i < 140; i += 1) {
    const size = Math.round(30 + 80 * random());
    const latitude = 52.45 + 0.1 * random();
    const longitude = 13.3 + 0.2 * random();
    const pricePerSqm = 12 * Math.exp(-0.2 * Math.log(size / 70) + 0.1 * (random() - 0.5));
    const address = `Straße ${i}, 10${100 + i} Berlin`;
    insertListing.run({
      id: `l${i}`,
      createdAt: NOW - Math.floor(random() * 60) * 86400000,
      price: Math.round(pricePerSqm * size),
      size,
      address,
      link: `https://portal/expose/${i}`,
      latitude,
      longitude,
    });
    insertAttrs.run({ listingId: `l${i}`, parsedAt: NOW });
    insertGeo.run({ key: addressKey(address), address });
  }
}

describe('marketModel orchestrator', () => {
  beforeAll(async () => {
    const db = new Database(dbPath);
    seed(db);
    db.close();
    process.env.FREDY_PYTHON_BIN = '/nonexistent/python3'; // force gbm skip
    await initMarketModel({ dbPath });
    await runMarketModelOnce();
  }, 180000);

  afterAll(() => {
    delete process.env.FREDY_PYTHON_BIN;
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('persists the ridge artifact in the registry even when the gbm trainer is unavailable', () => {
    const db = new Database(dbPath, { readonly: true });
    const families = db.prepare(`SELECT family FROM homeserver_models ORDER BY family`).all();
    expect(families.map((row) => row.family)).toEqual(['ridge']);
    const artifact = JSON.parse(db.prepare(`SELECT artifact_json FROM homeserver_models`).get().artifact_json);
    expect(artifact.version).toBe('ridge-v4');
    expect(artifact.conformal).not.toBeNull();
    db.close();
  });

  it('writes a per-family evaluation run', () => {
    const db = new Database(dbPath, { readonly: true });
    const run = db.prepare(`SELECT * FROM homeserver_model_runs WHERE model_family = 'ridge'`).get();
    expect(run).toBeDefined();
    const metrics = JSON.parse(run.metrics_json);
    expect(metrics.evaluation.point.mdape).toBeGreaterThan(0);
    expect(metrics.corpus.trainableRows).toBeGreaterThan(100);
    db.close();
  });

  it('batch-scores the corpus with interval bounds', () => {
    const db = new Database(dbPath, { readonly: true });
    const scores = db.prepare(`SELECT * FROM homeserver_listing_market_model WHERE model_family = 'ridge'`).all();
    expect(scores.length).toBeGreaterThan(100);
    const scored = scores.find((row) => row.predicted_lo_price_per_sqm != null);
    expect(scored.predicted_lo_price_per_sqm).toBeLessThan(scored.predicted_hi_price_per_sqm);
    db.close();
  });

  it('persists surface cells and writes the geojson layer atomically', () => {
    const db = new Database(dbPath, { readonly: true });
    const cells = db.prepare(`SELECT count(*) AS n FROM homeserver_market_surface_cells`).get();
    expect(cells.n).toBeGreaterThan(10);
    db.close();
    const geojson = JSON.parse(fs.readFileSync(path.join(workDir, 'surface', 'surface.geojson'), 'utf8'));
    expect(geojson.type).toBe('FeatureCollection');
    expect(geojson.features.length).toBeGreaterThan(10);
    expect(geojson.features[0].geometry.type).toBe('Polygon');
  });

  it('reports per-family status', () => {
    const status = getMarketModelStatus();
    expect(status).toHaveLength(1);
    expect(status[0].model_family).toBe('ridge');
    expect(status[0].predictions).toBeGreaterThan(100);
  });
});
