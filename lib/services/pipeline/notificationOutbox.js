/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { nanoid } from 'nanoid';
import SqliteConnection from '../storage/SqliteConnection.js';

export function enqueueNotificationDeliveries(listingId, job, provider) {
  if (!listingId || !Array.isArray(job?.notificationAdapter)) return;
  const now = Date.now();
  const stmt = SqliteConnection.getConnection().prepare(
    `INSERT OR IGNORE INTO notification_deliveries (
       id, listing_id, job_id, provider, adapter_id, adapter_ordinal,
       status, attempts, next_attempt_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?)`,
  );
  job.notificationAdapter.forEach((adapter, index) => {
    if (adapter?.id) stmt.run(nanoid(), listingId, job.id, provider, adapter.id, index, now);
  });
}

export function getDueDeliveries(now = Date.now()) {
  return SqliteConnection.query(
    `SELECT l.*, d.id AS delivery_id, d.job_id, d.provider, d.adapter_id,
            d.adapter_ordinal, d.status AS delivery_status, d.attempts AS delivery_attempts,
            j.enabled AS job_enabled, j.notification_adapter,
            a.cold_rent_eur, a.warm_rent_eur, a.service_charges_eur, a.deposit_eur,
            a.price_type, a.floor, a.building_year, a.property_type, a.listing_type,
            a.availability, a.available_from, a.furnished, a.pets_allowed,
            a.amenities_json, a.comments
     FROM notification_deliveries d
     JOIN listings l ON l.id = d.listing_id
     JOIN jobs j ON j.id = d.job_id
     LEFT JOIN listing_attributes a ON a.listing_id = l.id
     WHERE d.status = 'pending' AND d.next_attempt_at <= @now
     ORDER BY d.job_id, d.provider, d.adapter_ordinal, l.created_at`,
    { now },
  );
}

/**
 * Load the persisted per-family market scores for a set of listings and
 * reconstruct the `scoreListingNow`-shaped object that
 * `formatScoreLine` expects, so notifications can render the score line
 * from durable data.
 *
 * @param {string[]} listingIds
 * @returns {Map<string, object>} listingId → score object
 */
export function getListingScores(listingIds) {
  const scores = new Map();
  if (!listingIds.length) return scores;
  const placeholders = listingIds.map(() => '?').join(',');
  const rows = SqliteConnection.getConnection()
    .prepare(`SELECT * FROM homeserver_listing_model_scores WHERE listing_id IN (${placeholders})`)
    .all(...listingIds);
  for (const row of rows) {
    if (!scores.has(row.listing_id)) {
      scores.set(row.listing_id, {
        actualPricePerSqm: row.actual_price_per_sqm,
        priceType: row.price_type,
        swap: Boolean(row.swap),
        models: {},
      });
    }
    scores.get(row.listing_id).models[row.model_family] = {
      family: row.model_family,
      version: row.model_version,
      fairPricePerSqm: row.fair_price_per_sqm,
      fairLoPricePerSqm: row.fair_lo_price_per_sqm,
      fairHiPricePerSqm: row.fair_hi_price_per_sqm,
      coverageLevel: row.coverage_level,
      deltaPercent: row.delta_percent,
      comps500m: row.comps_500m,
    };
  }
  return scores;
}

export function markDeliveriesSent(ids) {
  if (!ids.length) return;
  updateMany(`UPDATE notification_deliveries SET status = 'sent', sent_at = ?, last_error = NULL WHERE id IN`, ids, [
    Date.now(),
  ]);
}

export function markDeliveriesCancelled(ids, reason) {
  if (!ids.length) return;
  updateMany(`UPDATE notification_deliveries SET status = 'cancelled', last_error = ? WHERE id IN`, ids, [
    String(reason).slice(0, 1000),
  ]);
}

export function markDeliveriesFailed(ids, error) {
  if (!ids.length) return;
  const db = SqliteConnection.getConnection();
  const now = Date.now();
  const rows = db
    .prepare(`SELECT id, attempts FROM notification_deliveries WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  const stmt = db.prepare(
    `UPDATE notification_deliveries
     SET attempts = ?, status = ?, next_attempt_at = ?, last_error = ?
     WHERE id = ?`,
  );
  db.transaction(() => {
    for (const row of rows) {
      const attempts = row.attempts + 1;
      const status = attempts >= 8 ? 'failed' : 'pending';
      const delay = Math.min(24 * 60 * 60 * 1000, 15 * 60 * 1000 * 2 ** Math.max(0, attempts - 1));
      stmt.run(attempts, status, now + delay, String(error?.message || error).slice(0, 1000), row.id);
    }
  })();
}

function updateMany(prefix, ids, leadingParams) {
  const placeholders = ids.map(() => '?').join(',');
  SqliteConnection.getConnection()
    .prepare(`${prefix} (${placeholders})`)
    .run(...leadingParams, ...ids);
}
