/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { columnExists, tableExists } from '../../../../shared/sqlite.js';
import { jsonObject } from '../../../../shared/json.js';
import { ACCEPTED_SQL } from '../../../pipeline/terminalVerdict.js';
import { addHeader, metric } from '../promText.js';

export function collectModelMetrics(lines, context) {
  emitPredictionMetrics(lines, context.db);
}

function emitPredictionMetrics(lines, db) {
  if (!tableExists(db, 'homeserver_listing_model_scores') || !tableExists(db, 'homeserver_model_runs')) return;
  if (!columnExists(db, 'homeserver_model_runs', 'model_family')) return;

  const scoreQuery = buildScoreQuery(db);
  const snapshot = db.transaction(() => {
    const runs = db
      .prepare(
        `
        SELECT id, model_version, model_family, market, training_rows, scored_rows, created_at, metrics_json
        FROM homeserver_model_runs r
        WHERE model_family IS NOT NULL
          AND market IS NOT NULL
          AND created_at = (
            SELECT max(created_at) FROM homeserver_model_runs r2
            WHERE r2.model_family = r.model_family AND r2.market = r.market
          )
        ORDER BY market, model_family
        `,
      )
      .all();
    return runs.map((run) => ({
      run,
      visibleDeltas: scoreQuery.all(run.model_family, run.market).filter((row) => Boolean(row.accepted)),
    }));
  })();
  if (!snapshot.length) return;

  addHeader(
    lines,
    'fredy_market_prediction_model_created_timestamp_seconds',
    'gauge',
    'Unix timestamp for the latest market model run.',
  );
  addHeader(
    lines,
    'fredy_market_model_error_percent',
    'gauge',
    'Out-of-sample model error by evaluation method (cv = spatially blocked cross-validation, naive = predict the global median).',
  );
  addHeader(
    lines,
    'fredy_market_model_interval',
    'gauge',
    'Conformal interval quality from the evaluation pass: target level, honest coverage, median width percent.',
  );
  addHeader(
    lines,
    'fredy_market_delta_distribution',
    'gauge',
    'Visible scored listings bucketed by price delta percent (how mispriced the market currently is).',
  );

  for (const { run, visibleDeltas } of snapshot) {
    emitFamilyPredictionMetrics(lines, run, visibleDeltas);
  }
}

function buildScoreQuery(db) {
  return db.prepare(
    `SELECT s.delta_percent, ${ACCEPTED_SQL('l')} AS accepted
     FROM homeserver_listing_model_scores s
     JOIN listings l ON l.id = s.listing_id
     WHERE s.model_family = ? AND l.market = ?`,
  );
}

function emitFamilyPredictionMetrics(lines, latestRun, visibleDeltas) {
  const model = latestRun.model_family;
  const market = latestRun.market;

  metric(lines, 'fredy_market_prediction_model_created_timestamp_seconds', Math.floor(latestRun.created_at / 1000), {
    model,
    market,
  });

  const runMetrics = jsonObject(latestRun.metrics_json);
  const evaluation = runMetrics.evaluation || {};
  for (const [method, source] of [
    ['cv', evaluation.point],
    ['naive', evaluation.naive],
  ]) {
    if (Number.isFinite(source?.mdape)) {
      metric(lines, 'fredy_market_model_error_percent', source.mdape, { model, market, method, stat: 'mdape' });
    }
    if (Number.isFinite(source?.ppe10)) {
      metric(lines, 'fredy_market_model_error_percent', source.ppe10, { model, market, method, stat: 'ppe10' });
    }
  }
  const interval = evaluation.interval || {};
  metric(lines, 'fredy_market_model_interval', interval.level, { model, market, stat: 'level' });
  metric(lines, 'fredy_market_model_interval', interval.coverage, { model, market, stat: 'coverage' });
  metric(lines, 'fredy_market_model_interval', interval.medianWidthPercent, { model, market, stat: 'width_percent' });

  emitDeltaHistogram(lines, visibleDeltas, model, market);
}

function emitDeltaHistogram(lines, visibleDeltas, model, market) {
  const edges = [-60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60];
  for (let i = 0; i <= edges.length; i += 1) {
    const low = i === 0 ? -Infinity : edges[i - 1];
    const high = i === edges.length ? Infinity : edges[i];
    const count = visibleDeltas.filter((row) => row.delta_percent > low && row.delta_percent <= high).length;
    const label = i === 0 ? `<=${edges[0]}` : i === edges.length ? `>${edges.at(-1)}` : `${low}..${high}`;
    metric(lines, 'fredy_market_delta_distribution', count, {
      model,
      market,
      bucket: label,
      order: String(i).padStart(2, '0'),
    });
  }
}
