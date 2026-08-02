/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { listingAttributes } from '../listings/attributes.js';
import { recordListingAudit } from './sourceAudit.js';
import { alreadyNotified } from './terminalVerdict.js';
import { cancelWork, completeWork, dueWork, enqueueWork, nextDueAt, retryWork } from './workQueue.js';
import { env } from '../../shared/env.js';

/**
 * The notification side of the work queue.
 *
 * Notification work is keyed on the listing, which is the whole of what the
 * notification-adapter abstraction left behind: the old key was
 * (listing_id, adapter_id, adapter_ordinal) over a table with one possible
 * adapter_id and one possible ordinal. `pipeline_work.key` for kind 'notify'
 * *is* the listing id, which is why the due-delivery query can join listings
 * directly on it.
 *
 * Deliveries are not drained by a polling worker. They arrive in bursts when a
 * discovery run finishes rating, and a burst has to become one digest per job,
 * so the dispatcher reacts to a change here instead of claiming items one by
 * one. The two signals below are the whole interface.
 */

/** @type {((signal: 'ready'|'reschedule') => void)|null} */
let listener = null;

/**
 * Register the dispatcher. There is exactly one, in this process; an event
 * emitter for a single producer and a single consumer in the same directory was
 * indirection without a purpose.
 *
 * @param {(signal: 'ready'|'reschedule') => void} handler
 */
export function onOutboxChange(handler) {
  listener = handler;
}

/**
 * Queue one listing for delivery.
 *
 * 'ignore' on conflict is load-bearing: a listing that has already been sent
 * must never be re-sent because a later capture re-rated it.
 *
 * @param {string} listingId
 * @param {object} job
 * @param {string} provider
 * @returns {{inserted: number, suppressed: number}|undefined}
 */
export function enqueueNotification(listingId, job, provider) {
  if (!listingId || !job?.id) return undefined;
  // `mode: 'ignore'` alone means "once per listing, for as long as the work row
  // exists" — and scheduled maintenance prunes terminal work after thirty days,
  // so an advert still live on day thirty-one was announced a second time. The
  // verdict remembers delivery durably, and it is not pruned.
  if (alreadyNotified(SqliteConnection.getConnection(), listingId)) {
    return { inserted: 0, suppressed: 1 };
  }
  const enqueued = enqueueWork('notify', listingId, { listingId, jobId: job.id, provider }, { mode: 'ignore' });
  if (!enqueued.changed) return { inserted: 0, suppressed: 0 };

  recordListingAudit(listingId, {
    stage: 'notification',
    action: 'enqueued',
    payload: { provider },
  });
  listener?.('ready');
  return { inserted: 1, suppressed: 0 };
}

/** When the next pending delivery is due, for the dispatcher's exact timer. */
export function getNextDeliveryAt() {
  return nextDueAt('notify');
}

/**
 * Every delivery that is due, with everything a digest line needs.
 *
 * @param {number} [now]
 * @returns {object[]}
 */
export function getDueDeliveries(now = Date.now()) {
  const keys = dueWork('notify', now).map((item) => item.key);
  if (!keys.length) return [];
  const placeholders = keys.map(() => '?').join(',');
  return SqliteConnection.getConnection()
    .prepare(
      `SELECT l.*, w.attempt_count AS delivery_attempts,
              EXISTS (SELECT 1 FROM listing_verdicts v
                       WHERE v.listing_id = l.id AND v.verdict = 'accepted') AS accepted,
              json_extract(w.payload_json, '$.jobId') AS job_id,
              json_extract(w.payload_json, '$.provider') AS provider,
              a.data AS attributes_json,
              (
                SELECT i.storage_path
                FROM listing_images i
                WHERE i.download_status = 'stored'
                  AND i.storage_path IS NOT NULL
                  AND (
                    i.listing_id = l.id
                    OR i.queue_id IN (
                      SELECT s.parsing_queue_id
                      FROM listing_sources s
                      WHERE s.listing_id = l.id AND s.parsing_queue_id IS NOT NULL
                    )
                  )
                ORDER BY CASE WHEN i.listing_id = l.id THEN 0 ELSE 1 END, i.position ASC
                LIMIT 1
              ) AS stored_image_path
       FROM pipeline_work w
       JOIN listings l ON l.id = w.key
       LEFT JOIN listing_attributes a ON a.listing_id = l.id
       WHERE w.kind = 'notify' AND w.key IN (${placeholders})
       ORDER BY job_id, provider, l.created_at`,
    )
    .all(...keys)
    .map((row) => ({ ...row, ...listingAttributes(row) }));
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

/** 'sent' rather than 'completed': the status is the record of what happened. */
export function markDeliveriesSent(listingIds) {
  for (const listingId of listingIds) {
    completeWork('notify', listingId, { status: 'sent', action: 'sent', code: 'delivered' });
    auditDelivery(listingId, 'sent');
  }
}

export function markDeliveriesCancelled(listingIds, reason, code = 'listing_hidden') {
  for (const listingId of listingIds) {
    cancelWork('notify', listingId, reason, { code });
    auditDelivery(listingId, 'cancelled', reason);
  }
}

/**
 * Telegram was unreachable. The shared backoff applies: the notification outbox
 * used to wait 15 minutes and give up after 24 hours, which outlived the advert
 * it was announcing.
 */
export function markDeliveriesFailed(listingIds, error) {
  for (const listingId of listingIds) {
    // Bounded. `notify` is not a registered handler, so it never got the
    // maxAttempts every other kind now declares, and passing no ceiling here
    // meant a permanently misconfigured Telegram adapter accumulated rows that
    // could never reach a terminal state.
    const result = retryWork('notify', listingId, error, {
      stage: 'notification',
      maxFailures: env('FREDY_NOTIFY_MAX_FAILURES'),
    });
    auditDelivery(listingId, result.status === 'dead' ? 'failed' : 'retry', String(error?.message || error));
  }
  if (listingIds.length) listener?.('reschedule');
}

function auditDelivery(listingId, action, reason = null) {
  recordListingAudit(listingId, { queueId: listingId, stage: 'notification', action, reason });
}
