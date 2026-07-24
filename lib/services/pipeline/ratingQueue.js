/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { getJob } from '../storage/jobStorage.js';
import logger from '../logger.js';
import { scoreListingNow } from '../scoring/marketScore.js';
import { enqueueNotificationDeliveries } from './notificationOutbox.js';
import { recordListingAudit } from './sourceAudit.js';
import { heartbeatWorker, recordWorkerLoopRestart, registerWorker, superviseWorkerItem } from './workerSupervisor.js';

const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const WORKER_NAME = 'rating';

export function enqueueRating(listingId, jobId, provider, { notify = false } = {}) {
  const now = Date.now();
  SqliteConnection.execute(
    `INSERT INTO rating_queue (
       listing_id, job_id, provider, notify, status, created_at, updated_at
     ) VALUES (@listingId, @jobId, @provider, @notify, 'pending', @now, @now)
     ON CONFLICT(listing_id) DO UPDATE SET
       job_id = excluded.job_id, provider = excluded.provider,
       notify = MAX(rating_queue.notify, excluded.notify), status = 'pending',
       attempt_count = 0, lease_until = NULL, next_attempt_at = 0,
       last_error = NULL, completed_at = NULL, updated_at = excluded.updated_at`,
    { listingId, jobId, provider, notify: notify ? 1 : 0, now },
  );
  recordListingAudit(listingId, {
    queueId: listingId,
    stage: 'score',
    action: 'enqueued',
    payload: { notify: Boolean(notify), provider },
  });
}

export function startRatingWorker() {
  if (process.env.FREDY_RATING_ENABLED === '0') {
    logger.info('Market rating worker is disabled.');
    return;
  }
  registerWorker(WORKER_NAME, { maxOperationMs: ratingItemTimeoutMs() });
  void superviseLoop();
  logger.info('Market rating worker started.');
}

async function runLoop() {
  const idleMs = positiveEnv('FREDY_RATING_IDLE_POLL_MS', 1000);
  while (true) {
    heartbeatWorker(WORKER_NAME);
    const item = claimRating();
    if (!item) {
      await delay(idleMs);
      continue;
    }
    try {
      await superviseWorkerItem(
        WORKER_NAME,
        item.listing_id,
        (signal) => {
          signal.throwIfAborted();
          return processRating(item);
        },
        { timeoutMs: ratingItemTimeoutMs() },
      );
    } catch (error) {
      retryRating(item, error);
      logger.warn(`Market rating failed for listing '${item.listing_id}'; retrying.`, error);
    }
  }
}

async function superviseLoop() {
  const restartDelayMs = positiveEnv('FREDY_WORKER_RESTART_DELAY_MS', 5000);
  while (true) {
    try {
      await runLoop();
    } catch (error) {
      recordWorkerLoopRestart(WORKER_NAME, error);
      logger.error('Rating worker loop stopped unexpectedly; restarting.', error);
      await delay(restartDelayMs);
    }
  }
}

function processRating(item) {
  const db = SqliteConnection.getConnection();
  const row = loadRatingInput(db, item.listing_id);
  if (!row) {
    completeRating(item.listing_id, 'cancelled', 'Listing disappeared before rating');
    return { status: 'cancelled', score: null };
  }
  if (row.manually_deleted !== 0 || row.hidden_reason) {
    completeRating(item.listing_id, 'cancelled', row.hidden_reason || 'Listing manually deleted');
    return { status: 'cancelled', score: null };
  }
  const attrs = attributesFromRow(row);
  const score = scoreListingNow(row, attrs);
  storeScores(db, item.listing_id, score);
  const job = getJob(item.job_id);
  if (item.notify && job && row.is_active !== 0 && row.manually_deleted === 0 && !row.hidden_reason) {
    enqueueNotificationDeliveries(item.listing_id, job, item.provider);
  }
  const status = score ? 'completed' : 'waiting_model';
  completeRating(item.listing_id, status, score ? null : 'No compatible market model available');
  recordListingAudit(item.listing_id, {
    queueId: item.listing_id,
    stage: 'score',
    action: status,
    reason: score ? null : 'No compatible market model available',
    payload: score,
  });
  return { status, score };
}

function claimRating({ now = Date.now(), leaseMs = DEFAULT_LEASE_MS } = {}) {
  const db = SqliteConnection.getConnection();
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT * FROM rating_queue
         WHERE status IN ('pending', 'retry', 'processing')
           AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until < ?)
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(now, now);
    if (!row) return null;
    const interrupted = row.status === 'processing' ? 1 : 0;
    const changed = db
      .prepare(
        `UPDATE rating_queue SET status = 'processing', lease_until = ?,
           attempt_count = attempt_count + ?, updated_at = ?, last_error = NULL
         WHERE listing_id = ? AND (lease_until IS NULL OR lease_until < ?)`,
      )
      .run(now + leaseMs, interrupted, now, row.listing_id, now);
    return changed.changes ? db.prepare('SELECT * FROM rating_queue WHERE listing_id = ?').get(row.listing_id) : null;
  })();
}

function retryRating(item, error) {
  const now = Date.now();
  const attempt = Number(item.attempt_count) || 0;
  const base = Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(attempt, 9));
  const delayMs = Math.round(base * (0.8 + Math.random() * 0.4));
  SqliteConnection.execute(
    `UPDATE rating_queue SET status = 'retry', attempt_count = attempt_count + 1,
       lease_until = NULL, next_attempt_at = @nextAttemptAt, last_error = @error, updated_at = @now
     WHERE listing_id = @listingId`,
    {
      listingId: item.listing_id,
      nextAttemptAt: now + delayMs,
      error: String(error?.message || error).slice(0, 2000),
      now,
    },
  );
}

function completeRating(listingId, status, reason) {
  const now = Date.now();
  SqliteConnection.execute(
    `UPDATE rating_queue SET status = @status, lease_until = NULL,
       completed_at = @now, updated_at = @now, last_error = @reason
     WHERE listing_id = @listingId`,
    { listingId, status, now, reason },
  );
}

function loadRatingInput(db, listingId) {
  return db
    .prepare(
      `SELECT l.*, a.* FROM listings l
       JOIN listing_attributes a ON a.listing_id = l.id
       WHERE l.id = ?`,
    )
    .get(listingId);
}

function attributesFromRow(row) {
  return {
    coldRentEur: row.cold_rent_eur,
    warmRentEur: row.warm_rent_eur,
    serviceChargesEur: row.service_charges_eur,
    heatingCostsEur: row.heating_costs_eur,
    depositEur: row.deposit_eur,
    priceType: row.price_type ?? 'unknown',
    rooms: row.rooms,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    floor: row.floor,
    totalFloors: row.total_floors,
    buildingYear: row.building_year,
    propertyType: row.property_type,
    condition: row.condition,
    furnishingStatus:
      row.furnishing_status ?? (row.furnished === 1 ? 'full' : row.furnished === 0 ? 'none' : 'unknown'),
    furnished: row.furnished == null ? null : Boolean(row.furnished),
    leaseType: row.lease_type ?? 'unknown',
    swap: Boolean(row.swap),
    amenities: parseArray(row.amenities_json),
    amenitiesAbsent: parseArray(row.amenities_absent_json),
    features: parseObject(row.features_json),
  };
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

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ratingItemTimeoutMs() {
  return positiveEnv('FREDY_RATING_ITEM_TIMEOUT_MS', 30_000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
