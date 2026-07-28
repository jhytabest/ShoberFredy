/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'node:fs';
import path from 'node:path';

import { roundMetric } from './stats.js';

/**
 * Refresh the two listing point layers after model training. Keeping this out
 * of the Prometheus request path makes metrics collection read-only.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} dbPath
 */
export function writeListingGeojson(db, dbPath) {
  const outputDir = path.join(path.dirname(dbPath), 'surface');
  fs.mkdirSync(outputDir, { recursive: true });
  for (const model of ['gbm', 'ridge']) {
    const rows = db
      .prepare(
        `SELECT l.id, l.title, l.link, l.provider, l.created_at, l.price, l.size, l.rooms,
                l.latitude, l.longitude, s.actual_price_per_sqm, s.fair_price_per_sqm,
                s.fair_lo_price_per_sqm, s.fair_hi_price_per_sqm, s.delta_percent, s.comps_500m
         FROM homeserver_listing_model_scores s
         JOIN listings l ON l.id = s.listing_id
         WHERE s.model_family = ?
           AND l.is_active = 1 AND l.manually_deleted = 0 AND l.hidden_reason IS NULL
           AND l.latitude IS NOT NULL AND l.longitude IS NOT NULL
           AND l.latitude != -1 AND l.longitude != -1`,
      )
      .all(model);
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
    atomicWrite(path.join(outputDir, `listings-${model}.geojson`), {
      type: 'FeatureCollection',
      features,
    });
  }
}

function atomicWrite(destination, value) {
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, destination);
}

function shortenLabel(value, maxLength) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function listingDeltaColor(deltaPercent) {
  if (deltaPercent <= -20) return '#16864b';
  if (deltaPercent <= -10) return '#55a868';
  if (deltaPercent < 10) return '#e5b94b';
  if (deltaPercent < 20) return '#e17c45';
  return '#c83e4d';
}
