/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { columnExists, tableExists } from '../../../../shared/sqlite.js';
import { jsonObject } from '../../../../shared/json.js';
import { normalizeAddress } from '../../../geocoding/address.js';
import { clamp } from '../../../scoring/hedonicFeatures.js';
import { inferArea } from '../../corpus.js';
import { quantile } from '../../stats.js';
import { emptyFieldResult, fieldAt, hydrateField } from '../../models/ridgeField.js';
import { geocodePenaltyFor, EMPTY_FIELD_CONFIDENCE } from '../../conformal.js';
import { ACCEPTED_SQL } from '../../../pipeline/terminalVerdict.js';
import { addHeader, metric, numberLabel, shortenLabel } from '../promText.js';

const MIN_TOP_LISTING_CONFIDENCE = 0.3;

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
      predictions: scoreQuery.all(run.model_family, run.market).map(deriveScoreFields),
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

  // Same field the serving path evaluates, hydrated from the stored artifact,
  // so a confidence shown here is the confidence a listing was scored with. It
  // is the market's own field, for the same reason.
  for (const { run, predictions } of snapshot) {
    const ridgeArtifact = loadRidgeArtifact(db, run.market);
    emitFamilyPredictionMetrics(lines, run, predictions, {
      field: hydrateField(ridgeArtifact?.field),
      artifact: ridgeArtifact,
    });
  }

  // One series per city: the same day's asking prices in two markets are two
  // different facts. Either family's rows will do, since the series is the
  // asking price rather than any model's opinion of it.
  const byMarket = new Map();
  for (const { run, predictions } of snapshot) {
    if (!byMarket.has(run.market)) byMarket.set(run.market, predictions);
  }
  addHeader(
    lines,
    'fredy_market_daily_price_per_sqm',
    'gauge',
    'Daily EUR per square meter quantiles (cold-rent basis) of unique flats first seen on each day.',
  );
  for (const [market, predictions] of byMarket) emitHistoryMetrics(lines, predictions, market);
}

function loadRidgeArtifact(db, market) {
  if (!tableExists(db, 'homeserver_models')) return null;
  const row = db
    .prepare(`SELECT artifact_json FROM homeserver_models WHERE family = 'ridge' AND market = ?`)
    .get(market);
  return row ? jsonObject(row.artifact_json) : null;
}

function buildScoreQuery(db) {
  return db.prepare(
    `SELECT
       s.listing_id, s.model_family, s.actual_price_per_sqm, s.fair_price_per_sqm,
       s.fair_lo_price_per_sqm, s.fair_hi_price_per_sqm, s.delta_percent, s.coord_quality,
       l.state,
       ${ACCEPTED_SQL('l')} AS accepted,
       l.address, l.latitude, l.longitude, l.title, l.link,
       l.provider, l.size AS size_sqm, l.created_at AS listing_created_at,
       l.rooms AS rooms
     FROM homeserver_listing_model_scores s
     JOIN listings l ON l.id = s.listing_id
     WHERE s.model_family = ? AND l.market = ?`,
  );
}

function deriveScoreFields(row) {
  return {
    ...row,
    residual_price_per_sqm: row.actual_price_per_sqm - row.fair_price_per_sqm,
    price_eur: row.actual_price_per_sqm * row.size_sqm,
    area: inferArea(normalizeAddress(row.address)),
  };
}

function ridgeUncertainty(row, ridge) {
  const { field, artifact } = ridge;
  if (!field || !artifact?.projection) return { confidence: EMPTY_FIELD_CONFIDENCE, zScore: null };
  const hasCoords = Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude));
  const surface = hasCoords
    ? fieldAt(
        Number(row.longitude) * artifact.projection.metersPerLongitudeDegree,
        Number(row.latitude) * artifact.projection.metersPerLatitudeDegree,
        field,
      )
    : emptyFieldResult(field);
  const confidence = clamp(surface.confidence * geocodePenaltyFor(row.coord_quality), EMPTY_FIELD_CONFIDENCE, 1);
  const zScore =
    surface.spreadLog > 0 && row.actual_price_per_sqm > 0 && row.fair_price_per_sqm > 0
      ? Math.log(row.fair_price_per_sqm / row.actual_price_per_sqm) / surface.spreadLog
      : null;
  return { confidence, zScore };
}

function emitFamilyPredictionMetrics(lines, latestRun, rows, ridge) {
  const model = latestRun.model_family;
  const market = latestRun.market;
  // gbm has no local field, so it has no local dispersion: null means unknown.
  const withUncertainty = rows.map((row) => ({
    ...row,
    ...(model === 'ridge' ? ridgeUncertainty(row, ridge) : { confidence: null, zScore: null }),
  }));
  const visibleRows = withUncertainty.filter((row) => Boolean(row.accepted));
  const activeRows = withUncertainty.filter((row) => row.state === 'active' && Boolean(row.accepted));

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

  emitTopListingMetrics(lines, activeRows, model, market);
  emitDeltaHistogram(lines, visibleRows, model, market);
}

function emitTopListingMetrics(lines, activeRows, model, market) {
  const now = Date.now();
  for (const [window, windowMs] of [
    ['1d', 24 * 60 * 60 * 1000],
    ['7d', 7 * 24 * 60 * 60 * 1000],
  ]) {
    // Ridge carries a local confidence and is gated on it. gbm has no local
    // field, so its confidence is null and no threshold can apply — its picks
    // are unfiltered by design, not by oversight.
    const candidates = activeRows
      .filter(
        (row) =>
          (row.confidence == null || row.confidence >= MIN_TOP_LISTING_CONFIDENCE) &&
          Number.isFinite(row.listing_created_at) &&
          now - row.listing_created_at <= windowMs,
      )
      .sort((a, b) => a.delta_percent - b.delta_percent)
      .slice(0, 5);
    candidates.forEach((row, index) => {
      metric(lines, 'fredy_market_top_listing', row.delta_percent, {
        model,
        market,
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

function emitDeltaHistogram(lines, visibleRows, model, market) {
  const edges = [-60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60];
  for (let i = 0; i <= edges.length; i += 1) {
    const low = i === 0 ? -Infinity : edges[i - 1];
    const high = i === edges.length ? Infinity : edges[i];
    const count = visibleRows.filter((row) => row.delta_percent > low && row.delta_percent <= high).length;
    const label = i === 0 ? `<=${edges[0]}` : i === edges.length ? `>${edges.at(-1)}` : `${low}..${high}`;
    metric(lines, 'fredy_market_delta_distribution', count, {
      model,
      market,
      bucket: label,
      order: String(i).padStart(2, '0'),
    });
  }
}

function emitHistoryMetrics(lines, rows, market) {
  const days = 45;
  const byDay = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.listing_created_at)) continue;
    const date = new Date(row.listing_created_at).toISOString().slice(0, 10);
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(row);
  }
  const dates = [...byDay.keys()].sort().slice(-days);
  for (const date of dates) {
    const dayRows = byDay.get(date);
    const prices = dayRows.map((row) => row.actual_price_per_sqm);
    for (const [quantileLabel, quantileValue] of [
      ['p25', 0.25],
      ['p50', 0.5],
      ['p75', 0.75],
    ]) {
      metric(lines, 'fredy_market_daily_price_per_sqm', quantile(prices, quantileValue) || 0, {
        market,
        date,
        quantile: quantileLabel,
      });
    }
  }
}
