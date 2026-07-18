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
            j.enabled AS job_enabled, j.notification_adapter
     FROM notification_deliveries d
     JOIN listings l ON l.id = d.listing_id
     JOIN jobs j ON j.id = d.job_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= @now
     ORDER BY d.job_id, d.provider, d.adapter_ordinal, l.created_at`,
    { now },
  );
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
