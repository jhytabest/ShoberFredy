/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { getJob } from '../storage/jobStorage.js';
import { listingAttributes } from '../listings/attributes.js';
import { env } from '../../shared/env.js';
import { scoreListingNow } from '../scoring/marketScore.js';
import { enqueueNotification } from './notificationOutbox.js';
import { recordListingAudit } from './sourceAudit.js';
import { isAcceptedAnywhere } from './terminalVerdict.js';
import { completeWork, enqueueWork, registerHandler, startWorker, SINGLE_ATTEMPT } from './workQueue.js';

const WORKER_NAME = 'rating';

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

export function startRatingWorker() {
  registerHandler('rate', {
    name: WORKER_NAME,
    enabled: () => env('FREDY_RATING_ENABLED'),
    timeoutMs: () => env('FREDY_RATING_ITEM_TIMEOUT_MS'),
    maxAttempts: () => SINGLE_ATTEMPT,
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
    completeWork('rate', listingId, {
      status: 'cancelled',
      code: 'listing_gone',
      reason: 'Listing disappeared before rating',
    });
    return { status: 'cancelled', score: null };
  }
  if (row.state !== 'active' || !isAcceptedAnywhere(db, listingId)) {
    completeWork('rate', listingId, {
      status: 'cancelled',
      code: row.state !== 'active' ? 'listing_gone' : 'listing_not_accepted',
      reason: row.state !== 'active' ? `Listing is ${row.state}` : 'No job accepts this listing',
    });
    return { status: 'cancelled', score: null };
  }
  let score = null;
  try {
    score = scoreListingNow(row, listingAttributes(row));
    storeScores(db, listingId, score);
  } catch (error) {
    logger.event(
      'market_rating_failure',
      'error',
      `Market scoring failed for listing '${listingId}'; delivering it unscored.`,
      error,
    );
  }
  const job = getJob(jobId);
  if (notify && job && row.state === 'active' && isAcceptedAnywhere(db, listingId)) {
    enqueueNotification(listingId, job, provider);
  }
  const status = score ? 'completed' : 'waiting_model';
  const reason = score ? null : 'No compatible market model available';
  completeWork('rate', listingId, { status, reason, code: score ? 'rated' : 'no_market_model' });
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
      `SELECT l.*, a.data AS attributes_json, t.full_text AS full_text FROM listings l
       LEFT JOIN listing_attributes a ON a.listing_id = l.id
       LEFT JOIN listing_texts t ON t.listing_id = l.id
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
       coverage_level, delta_percent, comps_500m, coord_quality, swap
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      score.swap ? 1 : 0,
    );
  }
}
