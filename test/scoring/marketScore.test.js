/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeAll } from 'vitest';

// In-memory database standing in for the app's SqliteConnection singleton.
vi.mock('../../lib/services/storage/SqliteConnection.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  globalThis.__marketScoreTestDb = db;
  return {
    default: {
      getConnection: () => db,
      tableExists: (name) =>
        Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)),
    },
  };
});

const { scoreListingNow, formatScoreLine } = await import('../../lib/services/scoring/marketScore.js');
const { trainRidgeModel, buildSurfaceCells } = await import('../../lib/services/market/models/ridgeModel.js');
const { saveModel } = await import('../../lib/services/market/modelRegistry.js');
const { calibrateConformal } = await import('../../lib/services/market/conformal.js');
const { gbmFeatureNames } = await import('../../lib/services/scoring/hedonicFeatures.js');
const { addressKey } = await import('../../lib/services/geocoding/address.js');
const { syntheticRows } = await import('./../services/market/syntheticCorpus.js');

const db = globalThis.__marketScoreTestDb;
const NOW = 1750000000000;
const ADDRESS = 'Teststraße 1, 10999 Berlin';

const baseAttrs = {
  coldRentEur: null,
  warmRentEur: null,
  serviceChargesEur: null,
  heatingCostsEur: null,
  depositEur: null,
  priceType: 'cold',
  rooms: 2,
  floor: 1,
  buildingYear: 1980,
  propertyType: null,
  energyClass: null,
  petsAllowed: null,
  availableFrom: null,
  swap: false,
  features: {},
};

const listing = {
  price: 840,
  size: 70,
  title: 'Schöne Wohnung',
  description: '',
  address: ADDRESS,
  latitude: 52.5,
  longitude: 13.4,
};

/** Leaf-only LightGBM-shaped dump: constant prediction. */
function constantDump(leafValue) {
  return {
    max_feature_idx: gbmFeatureNames().length - 1,
    tree_info: [{ tree_structure: { leaf_value: leafValue } }],
  };
}

function seedGbmArtifact(createdAt) {
  const mid = Math.log(12);
  const conformalRows = Array.from({ length: 60 }, (_, i) => ({
    tier: 'trusted',
    yLog: mid + (i % 2 === 0 ? 0.05 : -0.05),
    loLog: mid - 0.1,
    hiLog: mid + 0.1,
  }));
  saveModel(db, {
    family: 'gbm',
    runId: `${createdAt}-gbm`,
    version: 'gbm-quantile-v1',
    createdAt,
    trainingRows: 60,
    artifact: {
      version: 'gbm-quantile-v1',
      family: 'gbm',
      trainedAt: createdAt,
      trainingRows: 60,
      level: 0.8,
      featureNames: gbmFeatureNames(),
      quantiles: { lo: 0.1, mid: 0.5, hi: 0.9 },
      boosters: { lo: constantDump(mid - 0.1), mid: constantDump(mid), hi: constantDump(mid + 0.1) },
      conformal: calibrateConformal({ mode: 'cqr', level: 0.8, rows: conformalRows }),
      trainingLogBand: { lo: mid - 1.5, hi: mid + 1.5 },
    },
    evaluation: {},
  });
}

describe('marketScore (dual models)', () => {
  it('fails open before any tables or artifacts exist', () => {
    expect(scoreListingNow(listing, { ...baseAttrs })).toBeNull();
  });

  describe('with seeded registry', () => {
    beforeAll(function seedRegistry() {
      db.exec(`
        CREATE TABLE homeserver_models (
          family TEXT PRIMARY KEY, run_id TEXT NOT NULL, model_version TEXT NOT NULL,
          created_at INTEGER NOT NULL, training_rows INTEGER NOT NULL,
          artifact_json TEXT NOT NULL, eval_json TEXT NOT NULL
        );
        CREATE TABLE homeserver_market_surface_cells (
          cell_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, model_version TEXT NOT NULL,
          created_at INTEGER NOT NULL, cell_size_m INTEGER NOT NULL,
          center_latitude REAL NOT NULL, center_longitude REAL NOT NULL,
          predicted_price_per_sqm REAL NOT NULL, confidence REAL NOT NULL,
          samples_250m INTEGER NOT NULL, samples_500m INTEGER NOT NULL, samples_1000m INTEGER NOT NULL,
          effective_samples REAL NOT NULL, surface_components_json TEXT NOT NULL
        );
        CREATE TABLE homeserver_geocode_cache (
          address_key TEXT PRIMARY KEY, source_address TEXT, status TEXT, latitude REAL, longitude REAL,
          accuracy TEXT, place_id TEXT, formatted_address TEXT, error TEXT, attempts INTEGER,
          created_at INTEGER, updated_at INTEGER
        );
      `);
      db.prepare(
        `INSERT INTO homeserver_geocode_cache (address_key, source_address, status, accuracy, attempts, created_at, updated_at)
         VALUES (?, ?, 'ok', 'house', 1, 1, 1)`,
      ).run(addressKey(ADDRESS), ADDRESS);

      // Real ridge artifact trained on the synthetic surface (fair ≈ 12 €/m²
      // around 52.5/13.4), surface cells included.
      const { rows, projection } = syntheticRows(220, { seed: 42 });
      const ridge = trainRidgeModel({ trainingRows: rows, projection, now: NOW, level: 0.8 });
      saveModel(db, {
        family: 'ridge',
        runId: `${NOW}-ridge`,
        version: ridge.artifact.version,
        createdAt: NOW,
        trainingRows: rows.length,
        artifact: ridge.artifact,
        evaluation: ridge.evaluation,
      });
      const insertCell = db.prepare(
        `INSERT INTO homeserver_market_surface_cells (
           cell_id, run_id, model_version, created_at, cell_size_m, center_latitude, center_longitude,
           predicted_price_per_sqm, confidence, samples_250m, samples_500m, samples_1000m,
           effective_samples, surface_components_json
         ) VALUES (@cellId, 'run', 'v', ${NOW}, @cellSizeM, @centerLatitude, @centerLongitude,
           @predictedPricePerSqm, @confidence, @samples250m, @samples500m, @samples1000m,
           @effectiveSamples, @surfaceComponentsJson)`,
      );
      for (const cell of buildSurfaceCells(ridge.model, rows, projection, 0.05)) insertCell.run(cell);

      seedGbmArtifact(NOW);
    }, 120000); // ridge CV training on the synthetic corpus takes ~15s

    it('scores with both families and calibrated intervals', () => {
      const score = scoreListingNow(listing, { ...baseAttrs });
      expect(score).not.toBeNull();
      expect(score.actualPricePerSqm).toBeCloseTo(12, 5);
      expect(score.priceType).toBe('cold');
      expect(score.coordQuality).toBe('trusted');

      const { ridge, gbm } = score.models;
      expect(ridge).not.toBeNull();
      expect(ridge.fairPricePerSqm).toBeGreaterThan(8);
      expect(ridge.fairPricePerSqm).toBeLessThan(18);
      expect(ridge.fairLoPricePerSqm).toBeLessThan(ridge.fairHiPricePerSqm);
      expect(ridge.coverageLevel).toBe(0.8);

      expect(gbm).not.toBeNull();
      expect(gbm.fairPricePerSqm).toBeCloseTo(12, 3);
      expect(gbm.fairLoPricePerSqm).toBeLessThan(gbm.fairHiPricePerSqm);
      expect(Number.isFinite(gbm.deltaPercent)).toBe(true);
    });

    it('scores listings without coordinates (missing tier)', () => {
      const score = scoreListingNow(
        { ...listing, latitude: null, longitude: null, address: 'Nirgendwo 5' },
        {
          ...baseAttrs,
        },
      );
      expect(score).not.toBeNull();
      expect(score.coordQuality).toBe('missing');
      expect(score.models.ridge).not.toBeNull();
      expect(score.models.gbm).not.toBeNull();
    });

    it('imputes cold rent for warm listings and labels the kind', () => {
      const score = scoreListingNow(
        { ...listing, provider: 'wgGesucht', price: 1040 },
        {
          ...baseAttrs,
          priceType: 'warm',
          coldRentEur: null,
          warmRentEur: 1040,
          serviceChargesEur: 200,
        },
      );
      expect(score.priceType).toBe('cold_est');
      expect(score.actualPricePerSqm).toBeCloseTo(840 / 70, 5);
      expect(formatScoreLine(score)).toContain('(~cold)');
    });

    it('skips a model whose training band the listing falls outside of', () => {
      const expensive = { ...listing, price: 70 * 200 }; // 200 €/m²
      const score = scoreListingNow(expensive, { ...baseAttrs });
      expect(score).toBeNull();
    });

    it('rejects garbage inputs', () => {
      expect(scoreListingNow({ ...listing, price: 0 }, { ...baseAttrs })).toBeNull();
      expect(scoreListingNow({ ...listing, size: 5 }, { ...baseAttrs })).toBeNull();
    });

    it('formatScoreLine renders both model segments with bands', () => {
      const score = scoreListingNow(listing, { ...baseAttrs });
      const line = formatScoreLine(score);
      expect(line).toContain('Ask 12.00 €/m² (cold)');
      expect(line).toContain('ridge fair');
      expect(line).toContain('gbm fair');
      expect(line).toMatch(/\[\d+\.\d–\d+\.\d\]/);
    });

    it('flags swap listings on the line', () => {
      const score = scoreListingNow(listing, { ...baseAttrs, swap: true });
      expect(formatScoreLine(score)).toContain('SWAP LISTING');
    });
  });
});
