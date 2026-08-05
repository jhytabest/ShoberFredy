/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * The ridge surface layer: the 125m cells the last ridge run persisted.
 *
 * Two consumers, one query. The obvious one is the surface metric family
 * itself. The second is the model collector, which needs the per-cell local log
 * spread and confidence to reconstruct the two ridge-only quantities the
 * retired batch table used to store per listing.
 */

import { tableExists } from '../../../shared/sqlite.js';
import { jsonObject } from '../../../shared/json.js';
import { finiteNumber } from '../../../shared/values.js';
import { buildProjection, gridKey, hasUsableCoordinates } from '../geo.js';
import { median } from '../stats.js';
import { addHeader, emitQuantiles, metric, numberLabel } from './promText.js';

/**
 * Look up the ridge residual field's local statistics for a coordinate.
 *
 * z_score and confidence were columns of the batch table because the trainer
 * had the residual field in memory when it wrote them. The field itself is not
 * persisted, but its per-cell summary is: homeserver_market_surface_cells
 * stores the local log spread and confidence of every 125m cell it kept. The
 * cell grid is defined by the projection recorded inside the ridge artifact, so
 * reading that reference latitude back is what makes a listing land on the same
 * cell the trainer used.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} surfaceRows
 * @returns {(latitude: unknown, longitude: unknown) => {spreadLog: number, confidence: number}|null}
 */
export function localFieldLookup(db, surfaceRows) {
  const projection = surfaceProjection(db, surfaceRows);
  const byCell = new Map();
  let cellSizeM = null;
  for (const row of surfaceRows) {
    // cell_id is "<size>m:<cellX>:<cellY>" on that same grid.
    const [size, cellX, cellY] = row.cell_id.split(':');
    cellSizeM ??= Number.parseInt(size, 10);
    byCell.set(`${cellX}:${cellY}`, {
      spreadLog: finiteNumber(jsonObject(row.surface_components_json).spreadLog),
      confidence: finiteNumber(row.confidence),
    });
  }
  return (latitude, longitude) => {
    if (!projection || !cellSizeM || !hasUsableCoordinates(latitude, longitude)) return null;
    const point = projection.project(Number(latitude), Number(longitude));
    return byCell.get(gridKey(point.x, point.y, cellSizeM)) ?? null;
  };
}

function surfaceProjection(db, surfaceRows) {
  if (tableExists(db, 'homeserver_models')) {
    const stored = db
      .prepare(
        `SELECT json_extract(artifact_json, '$.projection.referenceLatitude') AS reference_latitude
         FROM homeserver_models WHERE family = 'ridge'`,
      )
      .get();
    const referenceLatitude = finiteNumber(stored?.reference_latitude);
    if (referenceLatitude != null) return buildProjection(referenceLatitude);
  }
  // No artifact to read: derive the reference latitude from the cells
  // themselves, the same way the corpus derives it from the listings.
  const fallback = median(surfaceRows.map((row) => Number(row.center_latitude)));
  return fallback == null ? null : buildProjection(fallback);
}

/**
 * Surface cells of one run, or null when the table does not exist — the two
 * cases are kept apart because "no surface table" must publish nothing while
 * "table present, no cells for this run" must publish an honest zero.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string|undefined} runId latest ridge run id
 * @returns {object[]|null}
 */
export function loadSurfaceCells(db, runId) {
  if (!tableExists(db, 'homeserver_market_surface_cells')) return null;
  if (!runId) return [];
  return db
    .prepare(
      `
      SELECT cell_id, center_latitude, center_longitude, predicted_price_per_sqm, confidence,
             effective_samples, samples_500m, surface_components_json
      FROM homeserver_market_surface_cells
      WHERE run_id = ?
      `,
    )
    .all(runId);
}

/**
 * @param {string[]} lines
 * @param {object[]} rows loadSurfaceCells output (never null)
 */
export function emitSurfaceMetrics(lines, rows) {
  // Geomap heatmap: 125m cells aggregated to ~500m to keep series cardinality
  // in the hundreds. Value = median predicted EUR/m2 of the finer cells. The
  // degree size of 500m depends on latitude, so it comes from the projection
  // the data itself defines rather than from a hardcoded city centre.
  const projection = buildProjection(median(rows.map((row) => Number(row.center_latitude))) ?? 0);

  const aggDegreesLatitude = 500 / projection.metersPerLatitudeDegree;
  const aggDegreesLongitude = 500 / projection.metersPerLongitudeDegree;
  const buckets = new Map();
  for (const row of rows) {
    const key = `${Math.floor(row.center_latitude / aggDegreesLatitude)}:${Math.floor(
      row.center_longitude / aggDegreesLongitude,
    )}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  // Only the comps-density series is published per cell. The fair-price surface
  // itself is served to Grafana as surface.geojson, so emitting it here as well
  // duplicated ~160 high-cardinality series that no panel ever queried.
  addHeader(lines, 'fredy_market_surface_geo_samples', 'gauge', 'Local comps feeding each ~500m geomap grid cell.');
  for (const [key, cellRows] of buckets) {
    const [latitudeIndex, longitudeIndex] = key.split(':').map(Number);
    metric(lines, 'fredy_market_surface_geo_samples', Math.max(...cellRows.map((row) => row.samples_500m)), {
      cell: key,
      latitude: numberLabel((latitudeIndex + 0.5) * aggDegreesLatitude),
      longitude: numberLabel((longitudeIndex + 0.5) * aggDegreesLongitude),
    });
  }

  addHeader(
    lines,
    'fredy_market_surface_cells',
    'gauge',
    'Street-scale market surface cells generated by the latest market model.',
  );
  metric(lines, 'fredy_market_surface_cells', rows.length);

  addHeader(
    lines,
    'fredy_market_surface_price_per_sqm_eur',
    'gauge',
    'Predicted EUR per square meter quantiles across generated market surface cells.',
  );
  emitQuantiles(
    lines,
    'fredy_market_surface_price_per_sqm_eur',
    rows.map((row) => row.predicted_price_per_sqm),
  );

  addHeader(
    lines,
    'fredy_market_surface_confidence',
    'gauge',
    'Confidence quantiles across generated market surface cells.',
  );
  emitQuantiles(
    lines,
    'fredy_market_surface_confidence',
    rows.map((row) => row.confidence),
  );

  addHeader(
    lines,
    'fredy_market_surface_effective_samples',
    'gauge',
    'Effective sample size quantiles across generated market surface cells.',
  );
  emitQuantiles(
    lines,
    'fredy_market_surface_effective_samples',
    rows.map((row) => row.effective_samples),
  );
}
