/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Shoberfredy market model orchestrator: dual families, trained as equals.
 *
 * Every run loads ONE corpus (lib/services/market/corpus.js: cold-equivalent
 * target, cross-portal dedupe with duplicate clusters, coordinate
 * missingness kept) and trains BOTH model families on it:
 *
 * - 'ridge' (models/ridgeModel.js): robust standardized ridge regression on
 *   the hedonic design + adaptive-bandwidth spatial residual field.
 *   λ and recency half-life are chosen by spatially-blocked CV.
 * - 'gbm' (models/gbmModel.js): LightGBM quantile regression via a
 *   short-lived Python batch process; scored in-process by a pure-JS tree
 *   evaluator, so Python is never needed at scrape time.
 *
 * Both carry Mondrian split-conformal intervals (calibrated per
 * coordinate-quality tier on independently salted out-of-fold predictions)
 * and both are evaluated on the same folds with the same metrics
 * (MdAPE/PPE10 + interval coverage/width), persisted per family in
 * homeserver_model_runs. Artifacts land in the homeserver_models registry;
 * the notification-time scorer (lib/services/scoring/marketScore.js) renders
 * BOTH scores. A family that fails to train keeps its previous artifact
 * serving — the other family is unaffected.
 *
 * Usage: node tools/market/marketModel.js [run|daemon|status]
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveDbPath, openToolDb } from './marketDb.js';
import { loadCorpus } from './corpus.js';
import { trainRidgeModel, buildSurfaceCells, RIDGE_VERSION, RIDGE_FAMILY } from './models/ridgeModel.js';
import { trainGbmModel, prepareGbmArtifact, scoreGbmCorpusRow, GBM_VERSION, GBM_FAMILY } from './models/gbmModel.js';
import { saveModel } from './modelRegistry.js';
import { clamp } from '../scoring/hedonicFeatures.js';
import { roundMetric } from './stats.js';
import logger from '../logger.js';

const RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

let config = null;
let db = null;

/**
 * Initialize the market model against the listings database. Idempotent;
 * must be called before any run/status function. Called by index.js for the
 * in-process retrain cron and by the tools/market/marketModel.js CLI.
 *
 * @param {{dbPath?: string}} [options]
 */
export async function initMarketModel(options = {}) {
  if (db) return;
  config = {
    dbPath: options.dbPath || (await resolveDbPath()),
    intervalSeconds: intEnv('FREDY_MARKET_MODEL_INTERVAL_SECONDS', 24 * 60 * 60),
    surfaceMinConfidence: numberEnv('FREDY_MARKET_SURFACE_MIN_CONFIDENCE', 0.25),
    intervalLevel: clamp(numberEnv('FREDY_MARKET_INTERVAL_LEVEL', 0.8), 0.5, 0.99),
  };
  db = openToolDb(config.dbPath);
}

/**
 * Retrain loop for the standalone CLI daemon mode.
 */
export async function runMarketModelDaemon() {
  while (true) {
    try {
      await runMarketModelOnce();
    } catch (error) {
      logger.error('market model run failed', error);
    }
    await sleep(config.intervalSeconds * 1000);
  }
}

/**
 * Interval (seconds) between retrains, from FREDY_MARKET_MODEL_INTERVAL_SECONDS.
 * @returns {number}
 */
export function marketModelIntervalSeconds() {
  return config.intervalSeconds;
}

/**
 * Retrain both model families once on the shared corpus, persist artifacts,
 * per-family evaluation runs, batch scores and the ridge surface layer.
 *
 * @returns {Promise<void>}
 */
export async function runMarketModelOnce() {
  ensureTables();
  const startedAt = Date.now();
  const { rows, trainingRows, projection, stats } = loadCorpus(db, startedAt);
  const level = config.intervalLevel;

  let ridge = null;
  let gbm = null;
  try {
    ridge = trainRidgeModel({ trainingRows, projection, now: startedAt, level });
  } catch (error) {
    logger.error('ridge training failed; keeping previous ridge artifact', error);
  }
  try {
    gbm = await trainGbmModel({ trainingRows, now: startedAt, level });
  } catch (error) {
    logger.error('gbm training failed; keeping previous gbm artifact', error);
  }
  if (!ridge && !gbm) {
    logger.warn(
      `market model run skipped: corpus too small or trainers unavailable ` +
        `(${trainingRows.length} trainable rows); previous artifacts stay live`,
    );
    return;
  }

  const results = [];
  if (ridge) {
    try {
      results.push({
        family: RIDGE_FAMILY,
        version: RIDGE_VERSION,
        artifact: ridge.artifact,
        evaluation: ridge.evaluation,
        scores: rows.map((row) => ridge.model.scoreCorpusRow(row)),
        surfaceCells: buildSurfaceCells(ridge.model, trainingRows, projection, config.surfaceMinConfidence),
      });
    } catch (error) {
      logger.error('ridge result preparation failed; keeping previous ridge artifact', error);
    }
  } else {
    logger.warn('ridge family did not train this run; previous ridge artifact stays live');
  }
  if (gbm) {
    try {
      const prepared = prepareGbmArtifact(gbm.artifact);
      results.push({
        family: GBM_FAMILY,
        version: GBM_VERSION,
        artifact: gbm.artifact,
        evaluation: gbm.evaluation,
        scores: rows.map((row) => scoreGbmCorpusRow(row, prepared, gbm.artifact)),
        surfaceCells: null,
      });
    } catch (error) {
      logger.error('gbm result preparation failed; keeping previous gbm artifact', error);
    }
  } else {
    logger.warn('gbm family did not train this run; previous gbm artifact stays live');
  }

  const persistedResults = persistRun({ startedAt, stats, results });
  if (persistedResults.length && tableExists('rating_queue')) {
    const now = Date.now();
    const recovered = db
      .prepare(
        `UPDATE rating_queue
         SET status = 'pending', attempt_count = 0, lease_until = NULL,
             next_attempt_at = 0, last_error = NULL, completed_at = NULL,
             updated_at = ?
         WHERE status = 'unrated'`,
      )
      .run(now).changes;
    if (recovered) logger.info(`Requeued ${recovered} previously unrated listing(s) after model training.`);
  }

  const ridgeResult = persistedResults.find((result) => result.family === RIDGE_FAMILY);
  if (ridgeResult) {
    try {
      writeSurfaceGeojson(ridgeResult.surfaceCells, projection);
    } catch (error) {
      logger.error('surface geojson write failed (map layer will be stale)', error);
    }
  }

  for (const result of persistedResults) {
    logger.info(
      'market model run: ' +
        JSON.stringify({
          family: result.family,
          modelVersion: result.version,
          rawRows: stats.rawRows,
          uniqueFlats: stats.uniqueFlats,
          trainableRows: stats.trainableRows,
          scoredRows: result.scores.length,
          mdape: result.evaluation.point?.mdape ?? null,
          ppe10: result.evaluation.point?.ppe10 ?? null,
          intervalCoverage: result.evaluation.interval?.coverage ?? null,
          intervalWidthPercent: result.evaluation.interval?.medianWidthPercent ?? null,
          naiveMdape: result.evaluation.naive?.mdape ?? null,
          durationMs: Date.now() - startedAt,
        }),
    );
  }
}

/* ------------------------------ persistence ------------------------------ */

function persistRun({ startedAt, stats, results }) {
  const insertRun = db.prepare(
    `INSERT INTO homeserver_model_runs (id, model_version, model_family, training_rows, scored_rows, created_at, metrics_json)
     VALUES (@id, @modelVersion, @modelFamily, @trainingRows, @scoredRows, @createdAt, @metricsJson)`,
  );
  const insertScore = db.prepare(
    `INSERT INTO homeserver_listing_market_model (
      listing_id, model_family, run_id, model_version, created_at, listing_created_at, provider, link, title, is_hidden,
      actual_price_eur, target_rent_eur, price_type, size_sqm, rooms,
      actual_price_per_sqm, predicted_price_per_sqm, predicted_lo_price_per_sqm, predicted_hi_price_per_sqm,
      residual_price_per_sqm, delta_percent,
      z_score, percentile, confidence, nearby_comps_250m, nearby_comps_500m, nearby_comps_1000m,
      geo_cell, area, size_band, rooms_band, feature_flags_json, geocode_quality
    ) VALUES (
      @listingId, @modelFamily, @runId, @modelVersion, @createdAt, @listingCreatedAt, @provider, @link, @title, @isHidden,
      @actualPriceEur, @targetRentEur, @priceType, @sizeSqm, @rooms,
      @actualPricePerSqm, @predictedPricePerSqm, @predictedLoPricePerSqm, @predictedHiPricePerSqm,
      @residualPricePerSqm, @deltaPercent,
      @zScore, @percentile, @confidence, @nearbyComps250m, @nearbyComps500m, @nearbyComps1000m,
      @geoCell, @area, @sizeBand, @roomsBand, @featureFlagsJson, @geocodeQuality
    )`,
  );
  const insertSurfaceCell = db.prepare(
    `INSERT INTO homeserver_market_surface_cells (
      cell_id, run_id, model_version, created_at, cell_size_m,
      center_latitude, center_longitude, predicted_price_per_sqm, confidence,
      samples_250m, samples_500m, samples_1000m, effective_samples, surface_components_json
    ) VALUES (
      @cellId, @runId, @modelVersion, @createdAt, @cellSizeM,
      @centerLatitude, @centerLongitude, @predictedPricePerSqm, @confidence,
      @samples250m, @samples500m, @samples1000m, @effectiveSamples, @surfaceComponentsJson
    )`,
  );

  const persistedResults = [];
  for (const result of results) {
    try {
      db.transaction(() => {
        const runId = `${startedAt}-${result.family}`;
        insertRun.run({
          id: runId,
          modelVersion: result.version,
          modelFamily: result.family,
          trainingRows: stats.trainableRows,
          scoredRows: result.scores.length,
          createdAt: startedAt,
          metricsJson: JSON.stringify({
            corpus: stats,
            evaluation: result.evaluation,
            medianAbsoluteError:
              roundMetric(
                medianOf(result.scores.map((row) => Math.abs(row.residualPricePerSqm)).filter(Number.isFinite)),
              ) || 0,
          }),
        });
        db.prepare(`DELETE FROM homeserver_listing_market_model WHERE model_family = ?`).run(result.family);
        for (const row of result.scores) {
          insertScore.run({
            ...row,
            modelFamily: result.family,
            runId,
            modelVersion: result.version,
            createdAt: startedAt,
            listingCreatedAt: row.createdAt,
          });
        }
        if (result.surfaceCells) {
          db.prepare(`DELETE FROM homeserver_market_surface_cells`).run();
          for (const cell of result.surfaceCells) {
            insertSurfaceCell.run({ ...cell, runId, modelVersion: result.version, createdAt: startedAt });
          }
        }
        saveModel(db, {
          family: result.family,
          runId,
          version: result.version,
          createdAt: startedAt,
          trainingRows: stats.trainableRows,
          artifact: result.artifact,
          evaluation: result.evaluation,
        });
      })();
      persistedResults.push(result);
    } catch (error) {
      logger.error(`${result.family} persistence failed; keeping previous ${result.family} artifact`, error);
    }
  }

  try {
    db.prepare(`DELETE FROM homeserver_model_runs WHERE created_at < @cutoff`).run({
      cutoff: startedAt - RUN_RETENTION_MS,
    });
  } catch (error) {
    logger.warn('market model run retention cleanup failed; current artifacts remain available', error);
  }

  return persistedResults;
}

/**
 * Latest run summary per family (empty array when no run exists yet). Used
 * by the CLI status mode and container healthchecks.
 *
 * @returns {object[]}
 */
export function getMarketModelStatus() {
  ensureTables();
  return db
    .prepare(
      `SELECT r.*, count(m.listing_id) AS predictions
       FROM homeserver_model_runs r
       LEFT JOIN homeserver_listing_market_model m ON m.run_id = r.id
       WHERE r.created_at = (
         SELECT max(created_at) FROM homeserver_model_runs r2
         WHERE COALESCE(r2.model_family, '') = COALESCE(r.model_family, '')
       )
       GROUP BY r.id ORDER BY r.model_family`,
    )
    .all();
}

/*
 * Choropleth layer for the Grafana geomap: the ridge surface cells as real
 * polygons (fully tiling blocks), served by Grafana from a read-only mount
 * of the surface directory next to the database. Written atomically so
 * Grafana never reads a half file.
 */
function writeSurfaceGeojson(surfaceCells, projection) {
  const cellSizeM = surfaceCells[0]?.cellSizeM;
  const dir = path.join(path.dirname(config.dbPath), 'surface');
  fs.mkdirSync(dir, { recursive: true });
  const features = surfaceCells.map((row) => {
    const [, cellX, cellY] = row.cellId.split(':');
    const x0 = Number(cellX) * cellSizeM;
    const y0 = Number(cellY) * cellSizeM;
    const ring = [
      [x0, y0],
      [x0 + cellSizeM, y0],
      [x0 + cellSizeM, y0 + cellSizeM],
      [x0, y0 + cellSizeM],
      [x0, y0],
    ].map(([x, y]) => {
      const point = projection.unproject(x, y);
      return [Math.round(point.longitude * 1e6) / 1e6, Math.round(point.latitude * 1e6) / 1e6];
    });
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        price: Math.round(row.predictedPricePerSqm * 100) / 100,
        confidence: Math.round(row.confidence * 100) / 100,
        comps500m: row.samples500m,
        fill: surfaceFillColor(row.predictedPricePerSqm),
        'fill-opacity': 0.62,
        stroke: '#ffffff',
        'stroke-width': 0.35,
      },
    };
  });
  const tmpPath = path.join(dir, 'surface.geojson.tmp');
  fs.writeFileSync(tmpPath, JSON.stringify({ type: 'FeatureCollection', features }));
  fs.renameSync(tmpPath, path.join(dir, 'surface.geojson'));
}

function surfaceFillColor(pricePerSqm) {
  const colorStops = [
    { value: 8, color: [26, 150, 80] },
    { value: 21.5, color: [254, 224, 139] },
    { value: 35, color: [215, 48, 39] },
  ];
  const price = clamp(pricePerSqm, colorStops[0].value, colorStops.at(-1).value);
  const upperIndex = colorStops.findIndex((stop) => price <= stop.value);
  const upper = colorStops[upperIndex];
  const lower = colorStops[Math.max(0, upperIndex - 1)];
  const progress = lower === upper ? 0 : (price - lower.value) / (upper.value - lower.value);
  const channels = lower.color.map((channel, index) => Math.round(channel + (upper.color[index] - channel) * progress));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/*
 * Tables are owned by migrations 22/26 in the main app; this keeps the
 * standalone daemon self-sufficient when it races a fresh database that has
 * not been migrated yet, and applies the same shape upgrades the migration
 * would (drop the pre-family batch table, add model_family to runs).
 */
function ensureTables() {
  if (
    tableExists('homeserver_listing_market_model') &&
    !columnExists('homeserver_listing_market_model', 'model_family')
  ) {
    db.exec(`DROP TABLE homeserver_listing_market_model`);
  }
  if (tableExists('homeserver_model_runs') && !columnExists('homeserver_model_runs', 'model_family')) {
    db.exec(`ALTER TABLE homeserver_model_runs ADD COLUMN model_family TEXT`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS homeserver_model_runs (
      id TEXT PRIMARY KEY,
      model_version TEXT NOT NULL,
      model_family TEXT,
      training_rows INTEGER NOT NULL,
      scored_rows INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      metrics_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_homeserver_model_runs_created_at
      ON homeserver_model_runs (created_at DESC);

    CREATE TABLE IF NOT EXISTS homeserver_models (
      family TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      training_rows INTEGER NOT NULL,
      artifact_json TEXT NOT NULL,
      eval_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS homeserver_listing_model_scores (
      listing_id TEXT NOT NULL,
      model_family TEXT NOT NULL,
      model_version TEXT NOT NULL,
      scored_at INTEGER NOT NULL,
      model_created_at INTEGER,
      actual_price_per_sqm REAL NOT NULL,
      fair_price_per_sqm REAL NOT NULL,
      fair_lo_price_per_sqm REAL,
      fair_hi_price_per_sqm REAL,
      coverage_level REAL,
      delta_percent REAL NOT NULL,
      comps_500m INTEGER,
      coord_quality TEXT,
      price_type TEXT,
      swap INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (listing_id, model_family)
    );

    CREATE INDEX IF NOT EXISTS idx_homeserver_listing_model_scores_family
      ON homeserver_listing_model_scores (model_family, scored_at DESC);

    CREATE TABLE IF NOT EXISTS homeserver_listing_market_model (
      listing_id TEXT NOT NULL,
      model_family TEXT NOT NULL,
      run_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      listing_created_at INTEGER,
      provider TEXT,
      link TEXT,
      title TEXT,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      actual_price_eur REAL NOT NULL,
      target_rent_eur REAL,
      price_type TEXT,
      size_sqm REAL NOT NULL,
      rooms REAL,
      actual_price_per_sqm REAL NOT NULL,
      predicted_price_per_sqm REAL NOT NULL,
      predicted_lo_price_per_sqm REAL,
      predicted_hi_price_per_sqm REAL,
      residual_price_per_sqm REAL NOT NULL,
      delta_percent REAL NOT NULL,
      z_score REAL,
      percentile REAL,
      confidence REAL,
      nearby_comps_250m INTEGER,
      nearby_comps_500m INTEGER,
      nearby_comps_1000m INTEGER,
      geo_cell TEXT,
      area TEXT,
      size_band TEXT,
      rooms_band TEXT,
      feature_flags_json TEXT,
      geocode_quality TEXT,
      PRIMARY KEY (listing_id, model_family)
    );

    CREATE INDEX IF NOT EXISTS idx_homeserver_listing_market_model_delta
      ON homeserver_listing_market_model (model_family, delta_percent ASC);
    CREATE INDEX IF NOT EXISTS idx_homeserver_listing_market_model_area
      ON homeserver_listing_market_model (area, rooms_band, size_band);

    CREATE TABLE IF NOT EXISTS homeserver_market_surface_cells (
      cell_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      cell_size_m INTEGER NOT NULL,
      center_latitude REAL NOT NULL,
      center_longitude REAL NOT NULL,
      predicted_price_per_sqm REAL NOT NULL,
      confidence REAL NOT NULL,
      samples_250m INTEGER NOT NULL,
      samples_500m INTEGER NOT NULL,
      samples_1000m INTEGER NOT NULL,
      effective_samples REAL NOT NULL,
      surface_components_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_homeserver_market_surface_cells_confidence
      ON homeserver_market_surface_cells (confidence DESC);
  `);
}

function tableExists(name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

function columnExists(table, column) {
  return db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column) !== undefined;
}

/* -------------------------------- helpers -------------------------------- */

function medianOf(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
