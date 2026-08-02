/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Market model metrics: run metadata and evaluation quality per family, the
 * distribution of scored listings, the dashboard's top-listing table, and the
 * ridge surface layer.
 *
 * Scores are read from homeserver_listing_model_scores — the live table the
 * API, the UI and the notification path already use. The exporter used to read
 * a second, Prometheus-only batch table (homeserver_listing_market_model) that
 * the retrain rewrote wholesale every night; two tables meant the dashboard
 * could disagree with the notification a user had just received. The columns of
 * that table with no equivalent in the live one are reconstructed here rather
 * than stored: see `deriveScoreFields` (residual, rent, area) and
 * `ridgeUncertainty` (z-score, confidence).
 */

import { columnExists, tableExists } from '../../../../shared/sqlite.js';
import { jsonObject } from '../../../../shared/json.js';
import { normalizeAddress } from '../../../geocoding/address.js';
import { clamp, gbmFeatureNames, hedonicTermNames } from '../../../scoring/hedonicFeatures.js';
import { inferArea } from '../../corpus.js';
import { quantile } from '../../stats.js';
import { emitSurfaceMetrics, loadSurfaceCells, localFieldLookup } from '../surfaceCells.js';
import { addHeader, emitQuantiles, metric, numberLabel, shortenLabel } from '../promText.js';

/** Confidence the trainer assigns where the residual field has no comps. */
const EMPTY_FIELD_CONFIDENCE = 0.05;
/** Confidence penalty for a listing whose geocode is not house/street precise. */
const COARSE_GEOCODE_PENALTY = 0.75;
const MODEL_FAMILIES = ['ridge', 'gbm'];

/**
 * @param {string[]} lines
 * @param {{db: import('better-sqlite3').Database}} context
 */
export function collectModelMetrics(lines, context) {
  const { db } = context;
  emitModelArtifactHealth(lines, db);
  emitPredictionMetrics(lines, db);
}

/* --------------------------- artifact registry --------------------------- */

/*
 * Trainer observability. Without these two families a broken trainer showed up
 * only as series that stopped arriving, which no alert can distinguish from a
 * scrape failure or a fresh deployment.
 */
function emitModelArtifactHealth(lines, db) {
  if (!tableExists(db, 'homeserver_models')) return;
  const expectedLengths = {
    ridge: hedonicTermNames().length,
    gbm: gbmFeatureNames().length,
  };
  // The feature-space length is measured in SQL rather than by parsing the
  // artifact: a GBM artifact carries three boosters and runs to megabytes, and
  // pulling that through JSON.parse on every scrape costs more than the whole
  // rest of the collection. json_valid() guards the extraction because CASE
  // short-circuits, so a corrupt artifact yields NULL instead of raising.
  const models = db
    .prepare(
      `SELECT family, created_at, artifact_json IS NULL AS artifact_missing,
              CASE WHEN json_valid(artifact_json)
                   THEN json_array_length(artifact_json, '$.beta') END AS beta_length,
              CASE WHEN json_valid(artifact_json)
                   THEN json_array_length(artifact_json, '$.featureNames') END AS feature_names_length
       FROM homeserver_models WHERE family IN ('ridge', 'gbm')`,
    )
    .all();
  addHeader(
    lines,
    'fredy_market_trainer_up',
    'gauge',
    'Whether each model family trained successfully in the last 26 hours.',
  );
  addHeader(
    lines,
    'fredy_market_model_artifact_compatible',
    'gauge',
    'Whether the stored artifact matches the current scoring feature space.',
  );
  addHeader(
    lines,
    'fredy_market_model_artifact_state',
    'gauge',
    'Why a family is or is not scoring: ok, stale (feature-space mismatch, the scorer rejects it), ' +
      'unreadable (artifact present but unparseable), missing (never trained).',
  );
  for (const family of MODEL_FAMILIES) {
    const model = models.find((candidate) => candidate.family === family);
    const age = model ? Date.now() - model.created_at : Number.POSITIVE_INFINITY;
    metric(lines, 'fredy_market_trainer_up', age <= 26 * 60 * 60 * 1000 ? 1 : 0, { family });
    // 'stale' and 'missing' both leave a family unscored, but they need
    // different responses: a mismatch means the shipped feature space moved and
    // a retrain is required, absence means no retrain has ever succeeded. The
    // scorers reject on vector length and say nothing, so the distinction has
    // to be published here.
    const state = artifactState(model, family, expectedLengths[family]);
    metric(lines, 'fredy_market_model_artifact_compatible', state === 'ok' ? 1 : 0, { family });
    for (const candidate of ['ok', 'stale', 'unreadable', 'missing']) {
      metric(lines, 'fredy_market_model_artifact_state', state === candidate ? 1 : 0, { family, state: candidate });
    }
  }
}

function artifactState(model, family, expectedLength) {
  if (!model || model.artifact_missing) return 'missing';
  const actualLength = family === 'ridge' ? model.beta_length : model.feature_names_length;
  if (!actualLength) return 'unreadable';
  return actualLength === expectedLength ? 'ok' : 'stale';
}

/* ---------------------------- scored listings ---------------------------- */

function emitPredictionMetrics(lines, db) {
  if (!tableExists(db, 'homeserver_listing_model_scores') || !tableExists(db, 'homeserver_model_runs')) return;
  // Mid-upgrade databases (no per-family runs yet) simply have no prediction
  // metrics until the first dual-model run lands.
  if (!columnExists(db, 'homeserver_model_runs', 'model_family')) return;

  const scoreQuery = buildScoreQuery(db);
  // Snapshot in one read transaction so a rating pass committing in between
  // cannot yield a run whose scores have already moved underneath it.
  const snapshot = db.transaction(() => {
    const runs = db
      .prepare(
        `
        SELECT id, model_version, model_family, training_rows, scored_rows, created_at, metrics_json
        FROM homeserver_model_runs r
        WHERE model_family IS NOT NULL
          AND created_at = (
            SELECT max(created_at) FROM homeserver_model_runs r2
            WHERE r2.model_family = r.model_family
          )
        ORDER BY model_family
        `,
      )
      .all();
    return runs.map((run) => ({ run, predictions: scoreQuery.all(run.model_family).map(deriveScoreFields) }));
  })();
  if (!snapshot.length) return;

  const ridgeRun = snapshot.find(({ run }) => run.model_family === 'ridge');
  const surfaceRows = loadSurfaceCells(db, ridgeRun?.run.id);
  const localField = localFieldLookup(db, surfaceRows ?? []);

  // Headers once; values per model family via the 'model' label.
  addHeader(lines, 'fredy_market_prediction_model_info', 'gauge', 'Latest market prediction model run metadata.');
  addHeader(
    lines,
    'fredy_market_prediction_model_created_timestamp_seconds',
    'gauge',
    'Unix timestamp for the latest market model run.',
  );
  addHeader(
    lines,
    'fredy_market_prediction_mae_eur_per_sqm',
    'gauge',
    'Median absolute prediction error of the latest model run in EUR per square meter.',
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
    'fredy_market_model_training_flats',
    'gauge',
    'Corpus composition of the latest model run (unique flats, trainable rows, exclusions).',
  );
  addHeader(
    lines,
    'fredy_market_prediction_scored_listings',
    'gauge',
    'Listings scored by the latest market prediction model.',
  );
  addHeader(
    lines,
    'fredy_market_prediction_price_per_sqm_eur',
    'gauge',
    'Actual and predicted EUR per square meter quantiles from the market model.',
  );
  addHeader(
    lines,
    'fredy_market_prediction_error_per_sqm_eur',
    'gauge',
    'Prediction residual quantiles in EUR per square meter.',
  );
  addHeader(lines, 'fredy_market_prediction_confidence', 'gauge', 'Prediction confidence quantiles from 0 to 1.');
  addHeader(
    lines,
    'fredy_market_top_listing',
    'gauge',
    'Best-priced active listings by model delta within a rolling window; value is the delta in percent.',
  );
  addHeader(
    lines,
    'fredy_market_delta_distribution',
    'gauge',
    'Visible scored listings bucketed by price delta percent (how mispriced the market currently is).',
  );

  for (const { run, predictions } of snapshot) {
    emitFamilyPredictionMetrics(lines, run, predictions, localField);
  }

  // Daily history uses actual prices, identical across families — emit once.
  emitHistoryMetrics(lines, snapshot[0].predictions);
  // The surface layer is produced by the ridge family only.
  if (ridgeRun && surfaceRows) emitSurfaceMetrics(lines, surfaceRows);
}

/**
 * One scored listing joined to its listing row.
 *
 * The room count used to be read from `listing_attributes` when a `rooms` column
 * was present there. That column has never existed — the table holds one `data`
 * document — so the probe was always false and the join was never added. Rooms
 * come from the listing row, which is where the canonical builder writes them.
 */
function buildScoreQuery(db) {
  return db.prepare(
    `SELECT
       s.listing_id, s.model_family, s.actual_price_per_sqm, s.fair_price_per_sqm,
       s.fair_lo_price_per_sqm, s.fair_hi_price_per_sqm, s.delta_percent, s.coord_quality,
       l.state,
       EXISTS (SELECT 1 FROM listing_verdicts v
                WHERE v.listing_id = l.id AND v.verdict = 'accepted') AS accepted,
       l.address, l.latitude, l.longitude, l.title, l.link,
       l.provider, l.size AS size_sqm, l.created_at AS listing_created_at,
       l.rooms AS rooms
     FROM homeserver_listing_model_scores s
     JOIN listings l ON l.id = s.listing_id
     WHERE s.model_family = ?`,
  );
}

/*
 * Columns the retired batch table stored and the live table does not:
 * - residual_price_per_sqm is pure arithmetic on the two prices;
 * - area was a reporting-only district label derived from the address text, so
 *   it is re-derived here with the corpus's own classifier — same input, same
 *   output, no stored copy to go stale.
 */
function deriveScoreFields(row) {
  return {
    ...row,
    residual_price_per_sqm: row.actual_price_per_sqm - row.fair_price_per_sqm,
    // The cold-equivalent rent the model actually scored, not listings.price:
    // €/m² is what the scorer persists, and size is what it divided by.
    price_eur: row.actual_price_per_sqm * row.size_sqm,
    area: inferArea(normalizeAddress(row.address)),
  };
}

/**
 * Ridge-only uncertainty for one scored row, reconstructed from the surface
 * cell the listing falls into. The GBM has no residual field — its uncertainty
 * story is the conformal interval — so it keeps reporting nothing here.
 */
function ridgeUncertainty(row, localField) {
  const cell = localField(row.latitude, row.longitude);
  const penalty = row.coord_quality === 'trusted' ? 1 : COARSE_GEOCODE_PENALTY;
  const confidence = clamp((cell?.confidence ?? EMPTY_FIELD_CONFIDENCE) * penalty, EMPTY_FIELD_CONFIDENCE, 1);
  const zScore =
    cell?.spreadLog > 0 && row.actual_price_per_sqm > 0 && row.fair_price_per_sqm > 0
      ? Math.log(row.fair_price_per_sqm / row.actual_price_per_sqm) / cell.spreadLog
      : null;
  return { confidence, zScore };
}

function emitFamilyPredictionMetrics(lines, latestRun, rows, localField) {
  const model = latestRun.model_family;
  const withUncertainty = rows.map((row) => ({
    ...row,
    ...(model === 'ridge' ? ridgeUncertainty(row, localField) : { confidence: null, zScore: null }),
  }));
  const visibleRows = withUncertainty.filter((row) => Boolean(row.accepted));
  const activeRows = withUncertainty.filter((row) => row.state === 'active' && Boolean(row.accepted));

  metric(lines, 'fredy_market_prediction_model_info', 1, {
    model,
    model_version: latestRun.model_version,
    run_id: latestRun.id,
  });
  metric(lines, 'fredy_market_prediction_model_created_timestamp_seconds', Math.floor(latestRun.created_at / 1000), {
    model,
  });

  const runMetrics = jsonObject(latestRun.metrics_json);
  metric(lines, 'fredy_market_prediction_mae_eur_per_sqm', Number(runMetrics.medianAbsoluteError), { model });

  const evaluation = runMetrics.evaluation || {};
  for (const [method, source] of [
    ['cv', evaluation.point],
    ['naive', evaluation.naive],
  ]) {
    if (Number.isFinite(source?.mdape)) {
      metric(lines, 'fredy_market_model_error_percent', source.mdape, { model, method, stat: 'mdape' });
    }
    if (Number.isFinite(source?.ppe10)) {
      metric(lines, 'fredy_market_model_error_percent', source.ppe10, { model, method, stat: 'ppe10' });
    }
  }
  const interval = evaluation.interval || {};
  metric(lines, 'fredy_market_model_interval', interval.level, { model, stat: 'level' });
  metric(lines, 'fredy_market_model_interval', interval.coverage, { model, stat: 'coverage' });
  metric(lines, 'fredy_market_model_interval', interval.medianWidthPercent, { model, stat: 'width_percent' });

  const corpus = runMetrics.corpus || {};
  metric(lines, 'fredy_market_model_training_flats', Number(corpus.uniqueFlats) || 0, { model, kind: 'unique' });
  metric(lines, 'fredy_market_model_training_flats', Number(corpus.rawRows) || 0, { model, kind: 'raw_rows' });
  metric(lines, 'fredy_market_model_training_flats', Number(corpus.trainableRows) || 0, { model, kind: 'trainable' });
  metric(lines, 'fredy_market_model_training_flats', Number(corpus.swapExcluded) || 0, {
    model,
    kind: 'swap_excluded',
  });
  metric(lines, 'fredy_market_model_training_flats', Number(corpus.unknownPriceType) || 0, {
    model,
    kind: 'unknown_price_type',
  });
  metric(lines, 'fredy_market_model_training_flats', Number(corpus.outlierExcluded) || 0, {
    model,
    kind: 'outlier_excluded',
  });

  metric(lines, 'fredy_market_prediction_scored_listings', withUncertainty.length, { model, scope: 'all_training' });
  metric(lines, 'fredy_market_prediction_scored_listings', visibleRows.length, { model, scope: 'all_visible' });
  metric(lines, 'fredy_market_prediction_scored_listings', activeRows.length, { model, scope: 'active_visible' });

  for (const [kind, selector] of [
    ['actual', (row) => row.actual_price_per_sqm],
    ['predicted', (row) => row.fair_price_per_sqm],
  ]) {
    for (const [label, q] of [
      ['p10', 0.1],
      ['p25', 0.25],
      ['p50', 0.5],
      ['p75', 0.75],
      ['p90', 0.9],
    ]) {
      metric(lines, 'fredy_market_prediction_price_per_sqm_eur', quantile(withUncertainty.map(selector), q) || 0, {
        model,
        kind,
        quantile: label,
      });
    }
  }

  for (const [label, q] of [
    ['p25', 0.25],
    ['p50', 0.5],
    ['p75', 0.75],
  ]) {
    metric(
      lines,
      'fredy_market_prediction_error_per_sqm_eur',
      quantile(
        withUncertainty.map((row) => row.residual_price_per_sqm),
        q,
      ) || 0,
      { model, quantile: label },
    );
  }

  const confidences = withUncertainty.map((row) => row.confidence).filter(Number.isFinite);
  if (confidences.length) {
    emitQuantiles(lines, 'fredy_market_prediction_confidence', confidences, { model });
  }

  emitTopListingMetrics(lines, activeRows, model);
  emitDeltaHistogram(lines, visibleRows, model);
}

/*
 * Best-priced listings for the dashboard table: rank 1..5 within a rolling
 * window, minimum confidence 0.3 so junk geocodes don't top the chart.
 * Display values ride along as labels — the metric value is the delta %.
 */
function emitTopListingMetrics(lines, activeRows, model) {
  const now = Date.now();
  for (const [window, windowMs] of [
    ['1d', 24 * 60 * 60 * 1000],
    ['7d', 7 * 24 * 60 * 60 * 1000],
  ]) {
    const candidates = activeRows
      .filter(
        (row) =>
          // The GBM carries no confidence value; its interval columns are the
          // quality signal, so it passes the junk-geocode gate unfiltered.
          (row.confidence == null || row.confidence >= 0.3) &&
          Number.isFinite(row.listing_created_at) &&
          now - row.listing_created_at <= windowMs,
      )
      .sort((a, b) => a.delta_percent - b.delta_percent)
      .slice(0, 5);
    candidates.forEach((row, index) => {
      metric(lines, 'fredy_market_top_listing', row.delta_percent, {
        model,
        window,
        rank: String(index + 1),
        listing_id: row.listing_id,
        title: shortenLabel(row.title, 60),
        link: row.link || '',
        area: row.area,
        provider: row.provider,
        first_seen: new Date(row.listing_created_at).toISOString(),
        price_eur: numberLabel(row.price_eur),
        size_sqm: numberLabel(row.size_sqm),
        rooms: numberLabel(row.rooms),
        price_per_sqm: numberLabel(row.actual_price_per_sqm),
        fair_per_sqm: numberLabel(row.fair_price_per_sqm),
        fair_lo_per_sqm: numberLabel(row.fair_lo_price_per_sqm),
        fair_hi_per_sqm: numberLabel(row.fair_hi_price_per_sqm),
        z_score: numberLabel(row.zScore),
        confidence: numberLabel(row.confidence),
        saving_eur_per_month: numberLabel(
          Math.max(0, (row.fair_price_per_sqm - row.actual_price_per_sqm) * row.size_sqm),
        ),
      });
    });
  }
}

function emitDeltaHistogram(lines, visibleRows, model) {
  const edges = [-60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60];
  for (let i = 0; i <= edges.length; i += 1) {
    const low = i === 0 ? -Infinity : edges[i - 1];
    const high = i === edges.length ? Infinity : edges[i];
    const count = visibleRows.filter((row) => row.delta_percent > low && row.delta_percent <= high).length;
    const label = i === 0 ? `<=${edges[0]}` : i === edges.length ? `>${edges.at(-1)}` : `${low}..${high}`;
    metric(lines, 'fredy_market_delta_distribution', count, {
      model,
      bucket: label,
      order: String(i).padStart(2, '0'),
    });
  }
}

/*
 * Daily history straight from the scored corpus (unique flats, cold-rent
 * basis), so the timeline exists immediately instead of waiting for
 * Prometheus to accumulate samples. One series per day, bounded window.
 */
function emitHistoryMetrics(lines, rows) {
  const days = 45;
  const byDay = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.listing_created_at)) continue;
    const date = new Date(row.listing_created_at).toISOString().slice(0, 10);
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(row);
  }
  const dates = [...byDay.keys()].sort().slice(-days);
  addHeader(
    lines,
    'fredy_market_daily_price_per_sqm',
    'gauge',
    'Daily EUR per square meter quantiles (cold-rent basis) of unique flats first seen on each day.',
  );
  addHeader(lines, 'fredy_market_daily_flats', 'gauge', 'Unique flats first seen on each day.');
  for (const date of dates) {
    const dayRows = byDay.get(date);
    const prices = dayRows.map((row) => row.actual_price_per_sqm);
    for (const [quantileLabel, quantileValue] of [
      ['p25', 0.25],
      ['p50', 0.5],
      ['p75', 0.75],
    ]) {
      metric(lines, 'fredy_market_daily_price_per_sqm', quantile(prices, quantileValue) || 0, {
        date,
        quantile: quantileLabel,
      });
    }
    metric(lines, 'fredy_market_daily_flats', dayRows.length, { date });
  }
}
