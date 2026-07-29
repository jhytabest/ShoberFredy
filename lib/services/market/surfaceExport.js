/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * GeoJSON map layers for Grafana, written next to the database in a directory
 * Grafana mounts read-only. Both layers are produced on the retrain path, never
 * while serving a request: a Prometheus scrape must not write to disk, and the
 * layers only change when a model run changes them anyway.
 *
 * Every file is written to a sibling .tmp and renamed into place, so Grafana
 * polling the directory can never read a half-written FeatureCollection.
 */

import fs from 'node:fs';
import path from 'node:path';

import { hasUsableCoordinates } from './geo.js';
import { shortenLabel } from './metrics/promText.js';
import { roundMetric } from './stats.js';
import { clamp } from '../scoring/hedonicFeatures.js';

/**
 * Choropleth layer: the ridge surface cells as real polygons (fully tiling
 * blocks) rather than points, so the geomap shades area instead of dots.
 *
 * @param {object[]} surfaceCells buildSurfaceCells output
 * @param {object} projection buildProjection output used to build the cells
 * @param {string} dbPath listings database path; the layer lands beside it
 */
export function writeSurfaceGeojson(surfaceCells, projection, dbPath) {
  const cellSizeM = surfaceCells[0]?.cellSizeM;
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
        'fill-opacity': 0.4,
        stroke: '#cbd5e1',
        'stroke-width': 0.12,
      },
    };
  });
  writeLayer(dbPath, 'surface.geojson', features);
}

/**
 * Point layers, one per model family: every live scored listing with its
 * asking price, the model's fair band and the resulting monthly saving.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} dbPath
 */
export function writeListingGeojson(db, dbPath) {
  for (const model of ['gbm', 'ridge']) {
    const rows = db
      .prepare(
        `SELECT l.id, l.title, l.link, l.provider, l.created_at, l.price, l.size, l.rooms,
                l.latitude, l.longitude, s.actual_price_per_sqm, s.fair_price_per_sqm,
                s.fair_lo_price_per_sqm, s.fair_hi_price_per_sqm, s.delta_percent, s.comps_500m
         FROM homeserver_listing_model_scores s
         JOIN listings l ON l.id = s.listing_id
         WHERE s.model_family = ?
           AND l.is_active = 1 AND l.manually_deleted = 0 AND l.hidden_reason IS NULL`,
      )
      .all(model)
      .filter((row) => hasUsableCoordinates(row.latitude, row.longitude));
    const features = rows.map((row) => {
      const monthlySaving = Math.max(0, (row.fair_price_per_sqm - row.actual_price_per_sqm) * row.size);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
        properties: {
          id: row.id,
          title: shortenLabel(row.title, 100),
          provider: row.provider,
          link: row.link,
          first_seen: new Date(row.created_at).toISOString(),
          rent_eur: roundMetric(row.price),
          size_sqm: roundMetric(row.size),
          rooms: roundMetric(row.rooms),
          asking_eur_per_sqm: roundMetric(row.actual_price_per_sqm),
          fair_eur_per_sqm: roundMetric(row.fair_price_per_sqm),
          fair_low_eur_per_sqm: roundMetric(row.fair_lo_price_per_sqm),
          fair_high_eur_per_sqm: roundMetric(row.fair_hi_price_per_sqm),
          delta_percent: roundMetric(row.delta_percent),
          saving_eur_per_month: roundMetric(monthlySaving),
          comps_500m: row.comps_500m,
          model,
          'marker-color': listingDeltaColor(row.delta_percent),
          'marker-size': monthlySaving >= 250 ? 'large' : monthlySaving >= 100 ? 'medium' : 'small',
        },
      };
    });
    writeLayer(dbPath, `listings-${model}.geojson`, features);
  }
}

function writeLayer(dbPath, fileName, features) {
  const outputDir = path.join(path.dirname(dbPath), 'surface');
  fs.mkdirSync(outputDir, { recursive: true });
  const destination = path.join(outputDir, fileName);
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ type: 'FeatureCollection', features }));
  fs.renameSync(temporary, destination);
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

function listingDeltaColor(deltaPercent) {
  if (deltaPercent <= -20) return '#16864b';
  if (deltaPercent <= -10) return '#55a868';
  if (deltaPercent < 10) return '#e5b94b';
  if (deltaPercent < 20) return '#e17c45';
  return '#c83e4d';
}
