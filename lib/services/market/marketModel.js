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
 * Usage: node tools/market/marketModel.js [run|status]
 * Env: FREDY_MARKET_MODEL_INTERVAL_SECONDS (0 disables retraining),
 *   FREDY_MARKET_SURFACE_MIN_CONFIDENCE, FREDY_MARKET_INTERVAL_LEVEL
 */

import { env } from '../../shared/env.js';
import { tableExists } from '../../shared/sqlite.js';
import { resolveDbPath, openToolDb } from './marketDb.js';
import { loadCorpus } from './corpus.js';
import { trainRidgeModel, buildSurfaceCells, RIDGE_VERSION, RIDGE_FAMILY } from './models/ridgeModel.js';
import { trainGbmModel, prepareGbmArtifact, scoreGbmCorpusRow, GBM_VERSION, GBM_FAMILY } from './models/gbmModel.js';
import { saveModel } from './modelRegistry.js';
import { isRetrainDisabled } from './retrainPolicy.js';
import { writeListingGeojson, writeSurfaceGeojson } from './surfaceExport.js';
import { clamp } from '../scoring/hedonicFeatures.js';
import { median, roundMetric } from './stats.js';
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
    surfaceMinConfidence: env('FREDY_MARKET_SURFACE_MIN_CONFIDENCE'),
    intervalLevel: clamp(env('FREDY_MARKET_INTERVAL_LEVEL'), 0.5, 0.99),
  };
  db = openToolDb(config.dbPath);
}

/**
 * Retrain both model families once on the shared corpus, persist artifacts,
 * per-family evaluation runs and the ridge surface layer, then refresh the
 * GeoJSON map layers.
 *
 * Per-listing scores are NOT written here: the rating queue writes them to
 * homeserver_listing_model_scores as listings are rated, which is the table the
 * API, the UI, the notifications and the exporter all read. Requeueing the
 * listings that were waiting for a model (below) is what makes them catch up.
 *
 * @returns {Promise<void>}
 */
export async function runMarketModelOnce() {
  if (isRetrainDisabled()) {
    logger.info('Market model retraining is disabled (FREDY_MARKET_MODEL_INTERVAL_SECONDS=0); keeping current model.');
    return;
  }
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
  if (persistedResults.length && tableExists(db, 'pipeline_work')) {
    const now = Date.now();
    const recovered = db
      .prepare(
        `UPDATE pipeline_work
         SET status = 'pending', attempt_count = 0, lease_until = NULL,
             next_attempt_at = 0, last_error = NULL,
             updated_at = ?
         WHERE kind = 'rate' AND outcome = 'waiting_model'`,
      )
      .run(now).changes;
    if (recovered) logger.info(`Requeued ${recovered} listing(s) waiting for a market model.`);
  }

  const ridgeResult = persistedResults.find((result) => result.family === RIDGE_FAMILY);
  if (ridgeResult) {
    try {
      writeSurfaceGeojson(ridgeResult.surfaceCells, projection, config.dbPath);
    } catch (error) {
      logger.error('surface geojson write failed (map layer will be stale)', error);
    }
  }
  if (persistedResults.length) {
    try {
      writeListingGeojson(db, config.dbPath);
    } catch (error) {
      logger.error('listing geojson write failed (map layer will be stale)', error);
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
              roundMetric(median(result.scores.map((row) => Math.abs(row.residualPricePerSqm)))) || 0,
          }),
        });
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
  return db
    .prepare(
      `SELECT r.*,
              (SELECT count(*) FROM homeserver_listing_model_scores s
               WHERE s.model_family = r.model_family) AS predictions
       FROM homeserver_model_runs r
       WHERE r.created_at = (
         SELECT max(created_at) FROM homeserver_model_runs r2
         WHERE COALESCE(r2.model_family, '') = COALESCE(r.model_family, '')
       )
       ORDER BY r.model_family`,
    )
    .all();
}
