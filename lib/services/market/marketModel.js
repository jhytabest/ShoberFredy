/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { env } from '../../shared/env.js';
import { resolveDbPath, openToolDb } from './marketDb.js';
import { loadCorpus } from './corpus.js';
import { trainRidgeModel, RIDGE_VERSION, RIDGE_FAMILY } from './models/ridgeModel.js';
import { trainGbmModel, prepareGbmArtifact, scoreGbmCorpusRow, GBM_VERSION, GBM_FAMILY } from './models/gbmModel.js';
import { saveModel } from './modelRegistry.js';
import { isRetrainDisabled } from './retrainPolicy.js';
import { requeueByOutcome } from '../pipeline/workQueue.js';
import { clamp } from '../scoring/hedonicFeatures.js';
import { median, roundMetric } from './stats.js';
import logger from '../logger.js';

const RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
let config = null;
let db = null;

export async function initMarketModel(options = {}) {
  if (db) return;
  config = {
    dbPath: options.dbPath || (await resolveDbPath()),
    intervalLevel: clamp(env('FREDY_MARKET_INTERVAL_LEVEL'), 0.5, 0.99),
  };
  db = openToolDb(config.dbPath);
}

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
      });
    } catch (error) {
      logger.error('gbm result preparation failed; keeping previous gbm artifact', error);
    }
  } else {
    logger.warn('gbm family did not train this run; previous gbm artifact stays live');
  }

  const persistedResults = persistRun({ startedAt, stats, results });
  if (persistedResults.length) {
    const recovered = requeueByOutcome('rate', 'waiting_model', db);
    if (recovered) logger.info(`Requeued ${recovered} listing(s) waiting for a market model.`);
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

function persistRun({ startedAt, stats, results }) {
  const insertRun = db.prepare(
    `INSERT INTO homeserver_model_runs (id, model_version, model_family, training_rows, scored_rows, created_at, metrics_json)
     VALUES (@id, @modelVersion, @modelFamily, @trainingRows, @scoredRows, @createdAt, @metricsJson)`,
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
