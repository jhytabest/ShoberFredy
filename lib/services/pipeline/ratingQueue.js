/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { getJob } from '../storage/jobStorage.js';
import { listingAttributes } from '../listings/attributes.js';
import { env } from '../../shared/env.js';
import { scoreListingNow } from '../scoring/marketScore.js';
import { enqueueNotification } from './notificationOutbox.js';
import { recordListingAudit } from './sourceAudit.js';
import { completeWork, enqueueWork, registerHandler, startWorker } from './workQueue.js';

const WORKER_NAME = 'rating';

/**
 * Ask for a listing to be scored against the market model.
 *
 * `notify` is merged rather than overwritten: the same listing can be re-rated
 * by a later capture that does not warrant a notification, and losing the flag
 * set by the first request would silently drop the delivery.
 *
 * @param {string} listingId
 * @param {string} jobId
 * @param {string} provider
 * @param {{notify?: boolean}} [options]
 */
export function enqueueRating(listingId, jobId, provider, { notify = false } = {}) {
  enqueueWork(
    'rate',
    listingId,
    { listingId, jobId, provider, notify },
    { merge: (stored, incoming) => ({ ...stored, ...incoming, notify: Boolean(stored.notify || incoming.notify) }) },
  );
  recordListingAudit(listingId, {
    queueId: listingId,
    stage: 'score',
    action: 'enqueued',
    payload: { notify: Boolean(notify), provider },
  });
}

/**
 * @returns {string|null} worker name, or null when rating is disabled
 */
export function startRatingWorker() {
  registerHandler('rate', {
    name: WORKER_NAME,
    enabled: () => env('FREDY_RATING_ENABLED'),
    timeoutMs: () => env('FREDY_RATING_ITEM_TIMEOUT_MS'),
    startedMessage: 'Market rating worker started.',
    handler: (item, { signal }) => {
      signal.throwIfAborted();
      return rateListing(item.key, item.payload);
    },
  });
  return startWorker('rate');
}

function rateListing(listingId, { jobId, provider, notify }) {
  const db = SqliteConnection.getConnection();
  const row = loadRatingInput(db, listingId);
  if (!row) {
    completeWork('rate', listingId, { status: 'cancelled', reason: 'Listing disappeared before rating' });
    return { status: 'cancelled', score: null };
  }
  if (row.manually_deleted !== 0 || row.hidden_reason) {
    completeWork('rate', listingId, {
      status: 'cancelled',
      reason: row.hidden_reason || 'Listing manually deleted',
    });
    return { status: 'cancelled', score: null };
  }
  const score = scoreListingNow(row, listingAttributes(row));
  storeScores(db, listingId, score);
  const job = getJob(jobId);
  if (notify && job && row.is_active !== 0 && row.manually_deleted === 0 && !row.hidden_reason) {
    enqueueNotification(listingId, job, provider);
  }
  const status = score ? 'completed' : 'waiting_model';
  const reason = score ? null : 'No compatible market model available';
  completeWork('rate', listingId, { status, reason });
  recordListingAudit(listingId, {
    queueId: listingId,
    stage: 'score',
    action: status,
    reason,
    payload: score,
  });
  return { status, score };
}

function loadRatingInput(db, listingId) {
  return db
    .prepare(
      `SELECT l.*, a.data AS attributes_json FROM listings l
       JOIN listing_attributes a ON a.listing_id = l.id
       WHERE l.id = ?`,
    )
    .get(listingId);
}

function storeScores(db, listingId, score) {
  db.prepare('DELETE FROM homeserver_listing_model_scores WHERE listing_id = ?').run(listingId);
  if (!score?.models) return;
  const stmt = db.prepare(
    `INSERT INTO homeserver_listing_model_scores (
       listing_id, model_family, model_version, scored_at, model_created_at,
       actual_price_per_sqm, fair_price_per_sqm, fair_lo_price_per_sqm, fair_hi_price_per_sqm,
       coverage_level, delta_percent, comps_500m, coord_quality, price_type, swap
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const model of Object.values(score.models)) {
    if (!model) continue;
    stmt.run(
      listingId,
      model.family,
      model.version ?? 'unknown',
      Date.now(),
      model.modelCreatedAt ?? null,
      score.actualPricePerSqm,
      model.fairPricePerSqm,
      model.fairLoPricePerSqm ?? null,
      model.fairHiPricePerSqm ?? null,
      model.coverageLevel ?? null,
      model.deltaPercent,
      model.comps500m ?? null,
      score.coordQuality ?? null,
      score.priceType ?? null,
      score.swap ? 1 : 0,
    );
  }
}
