/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import SqliteConnection from '../storage/SqliteConnection.js';
import { getJob } from '../storage/jobStorage.js';
import { canSpend, budgetStatus } from './llmBudget.js';
import { PIPELINE_SCHEMA_VERSION } from './pipelineVersion.js';
import {
  attachParsingQueue,
  findDiscoveryRepresentative,
  markDiscoveryDuplicate,
  markPreLlmHidden,
  recordDiscoverySource,
} from './sourceAudit.js';
import { canonicalUrl, discoveryDedupeKeys } from './temporaryDeterministic.js';
import { preLlmFilterReasons, primaryFilterReason } from './listingFilters.js';
export { PIPELINE_SCHEMA_VERSION } from './pipelineVersion.js';

/**
 * Version of the extraction contract (LLM schema + finalize semantics).
 * Bumping it lets re-enqueued captures supersede queue rows produced under
 * an older contract: the new row is inserted alongside and the old
 * pending/retry row is cancelled.
 */
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_BACKFILL_BURST = 3;

/**
 * Store one discovery card as durable pre-LLM evidence. The stable source key
 * intentionally excludes price: repricing creates a new evidence version of
 * the same provider offer instead of a second source identity.
 */
export function enqueueDiscovery({ jobId, provider, listing }) {
  const db = SqliteConnection.getConnection();
  const now = Date.now();
  const sourceUrl = canonicalUrl(listing.link);
  const sourceKey = String(listing.externalId || sourceUrl);
  const discoveryJson = JSON.stringify(listing);
  // Discovery timestamps are observations, not content. Excluding them stops
  // every scheduled run from requeueing an otherwise unchanged source.
  const discoveryHash = sha256(JSON.stringify({ ...listing, discoveredAt: undefined }));
  const dedupeKeys = discoveryDedupeKeys(listing);

  const result = db.transaction(() => {
    const existing = db
      .prepare(
        'SELECT id, discovery_hash, status FROM detail_fetch_queue WHERE job_id = ? AND provider = ? AND source_key = ?',
      )
      .get(jobId, provider, sourceKey);
    if (!existing) {
      const representative = findDiscoveryRepresentative(db, { jobId, provider, sourceKey, dedupeKeys });
      if (representative) {
        const source = recordDiscoverySource(db, {
          jobId,
          provider,
          sourceKey,
          sourceUrl,
          detailQueueId: representative.detail_queue_id,
          listing,
          discoveryHash,
          dedupeKeys,
        });
        markDiscoveryDuplicate(db, source.id, representative);
        return { id: representative.detail_queue_id, changed: true, deduped: true };
      }

      const id = nanoid();
      db.prepare(
        `INSERT INTO detail_fetch_queue (
           id, job_id, provider, source_key, external_id, source_url,
           discovery_json, discovery_hash, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        id,
        jobId,
        provider,
        sourceKey,
        listing.externalId ?? null,
        sourceUrl,
        discoveryJson,
        discoveryHash,
        now,
        now,
      );
      recordDiscoverySource(db, {
        jobId,
        provider,
        sourceKey,
        sourceUrl,
        detailQueueId: id,
        listing,
        discoveryHash,
        dedupeKeys,
      });
      return { id, changed: true };
    }

    recordDiscoverySource(db, {
      jobId,
      provider,
      sourceKey,
      sourceUrl,
      detailQueueId: existing.id,
      listing,
      discoveryHash,
      dedupeKeys,
    });
    if (existing.discovery_hash === discoveryHash) return { id: existing.id, changed: false };
    db.prepare(
      `UPDATE detail_fetch_queue
       SET external_id = ?, source_url = ?, discovery_json = ?, discovery_hash = ?,
           status = 'pending', attempt_count = 0, lease_until = NULL,
           next_attempt_at = 0, last_error = NULL, capture_queue_id = NULL,
           completed_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(listing.externalId ?? null, sourceUrl, discoveryJson, discoveryHash, now, existing.id);
    return { id: existing.id, changed: true };
  })();

  // The source and its discovery dedupe decision are already durable. If the
  // card itself proves a terminal filter, do not spend a detail request while
  // it waits behind a blocked provider.
  const reasons = preLlmFilterReasons(null, listing, getJob(jobId));
  if (reasons.length && result?.id) {
    const detail = hydrateDetailRow(db.prepare('SELECT * FROM detail_fetch_queue WHERE id = ?').get(result.id));
    if (detail) {
      const reason = primaryFilterReason(reasons);
      const sourceHash = sha256(JSON.stringify({ provider, sourceKey, discoveryHash, filtered: true }));
      markPreLlmHidden(detail, sourceHash, { fullText: '', images: [] }, reason, reasons);
      return { ...result, filtered: true };
    }
  }
  return result;
}

/** Claim the oldest due detail item across every job and provider. */
export function claimNextDetail({ now = Date.now(), leaseMs = DEFAULT_LEASE_MS } = {}) {
  const db = SqliteConnection.getConnection();
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT * FROM detail_fetch_queue
         WHERE status IN ('pending', 'retry', 'processing')
           AND next_attempt_at <= ?
           AND (lease_until IS NULL OR lease_until < ?)
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(now, now);
    if (!row) return null;
    const interrupted = row.status === 'processing' ? 1 : 0;
    const claimed = db
      .prepare(
        `UPDATE detail_fetch_queue
         SET status = 'processing', lease_until = ?, attempt_count = attempt_count + ?,
             updated_at = ?, last_error = NULL
         WHERE id = ? AND status IN ('pending', 'retry', 'processing')
           AND (lease_until IS NULL OR lease_until < ?)`,
      )
      .run(now + leaseMs, interrupted, now, row.id, now);
    if (!claimed.changes) return null;
    return hydrateDetailRow(db.prepare('SELECT * FROM detail_fetch_queue WHERE id = ?').get(row.id));
  })();
}

export function cancelDetail(id, reason, { action = 'cancelled', classification = null } = {}) {
  const now = Date.now();
  SqliteConnection.withTransaction((db) => {
    db.prepare(
      `UPDATE detail_fetch_queue
       SET status = 'cancelled', lease_until = NULL, completed_at = @now,
           updated_at = @now, last_error = @reason
       WHERE id = @id`,
    ).run({ id, now, reason: String(reason).slice(0, 2000) });
    auditQueueEvent(db, id, 'detail', action, reason, classification);
  });
}

export function retryDetail(id, error, { delayMs = 60_000, classification = null } = {}) {
  const now = Date.now();
  SqliteConnection.withTransaction((db) => {
    const changed = db
      .prepare(
        `UPDATE detail_fetch_queue
         SET status = 'retry', attempt_count = attempt_count + 1, lease_until = NULL,
             next_attempt_at = @nextAttemptAt, last_error = @error, updated_at = @now
         WHERE id = @id AND status = 'processing'`,
      )
      .run({
        id,
        nextAttemptAt: now + delayMs,
        error: String(error?.message || error).slice(0, 2000),
        now,
      });
    if (changed.changes) auditQueueEvent(db, id, 'detail', 'retry', error, classification);
  });
}

export function completeDetail(id, captureQueueId, capture = null) {
  const now = Date.now();
  SqliteConnection.execute(
    `UPDATE detail_fetch_queue
     SET status = 'completed', capture_queue_id = @captureQueueId,
         capture_json = COALESCE(@captureJson, capture_json),
         lease_until = NULL, completed_at = @now, updated_at = @now,
         last_error = NULL
     WHERE id = @id AND status != 'cancelled'`,
    { id, captureQueueId, captureJson: capture == null ? null : JSON.stringify(capture), now },
  );
}

export function markDetailInactive(id, reason, capture) {
  const now = Date.now();
  SqliteConnection.withTransaction((db) => {
    db.prepare(
      `UPDATE detail_fetch_queue
       SET status = 'inactive', lease_until = NULL, completed_at = @now,
           updated_at = @now, last_error = @reason, capture_json = @captureJson
       WHERE id = @id AND status != 'cancelled'`,
    ).run({
      id,
      now,
      reason: String(reason || 'Provider marks listing inactive').slice(0, 2000),
      captureJson: capture == null ? null : JSON.stringify(capture),
    });
    auditQueueEvent(db, id, 'detail', 'inactive', reason);
  });
}

export function captureVersionHash(provider, sourceKey, capture) {
  return sha256(
    JSON.stringify({
      provider,
      sourceKey,
      sourceUrl: canonicalSourceUrl(capture.sourceUrl),
      fullText: capture.fullText || '',
      embeddedData: capture.embeddedData || [],
    }),
  );
}

export function enqueueCapture({
  jobId,
  provider,
  sourceHash,
  capture,
  images = [],
  queueKind = 'live',
  listingId,
  detailQueueId,
}) {
  const db = SqliteConnection.getConnection();
  const now = Date.now();
  const queueId = nanoid();

  const effectiveQueueId = db.transaction(() => {
    const stableUrl = canonicalUrl(capture.sourceUrl);
    const externalId = String(capture.externalId || '').trim();
    const active = db
      .prepare(
        `SELECT * FROM parsing_queue
         WHERE job_id = ? AND provider = ? AND schema_version = ?
           AND status IN ('pending', 'retry', 'processing')`,
      )
      .all(jobId, provider, PIPELINE_SCHEMA_VERSION)
      .find((row) => {
        const sameUrl = stableUrl && canonicalUrl(row.source_url) === stableUrl;
        const sameExternal = externalId && String(row.external_id || '').trim() === externalId;
        return sameUrl || sameExternal;
      });
    if (active) {
      // There is only one unfinished semantic parse per stable provider ad,
      // even if discovery text or price changed its content hash. Preserve a
      // backfill listing target and refresh only work that has not started.
      if (active.status !== 'processing') {
        db.prepare(
          `UPDATE parsing_queue
           SET listing_id = COALESCE(listing_id, ?), external_id = ?, source_url = ?,
               discovered_at = ?, capture_json = ?, status = 'pending', stage = 'captured',
               attempt_count = 0, llm_attempt_count = 0, geocode_attempt_count = 0,
               lease_until = NULL, next_attempt_at = 0, last_error = NULL,
               completed_at = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(
          listingId ?? null,
          capture.externalId ?? active.external_id,
          capture.sourceUrl ?? active.source_url,
          capture.discoveredAt ?? now,
          JSON.stringify(capture),
          now,
          active.id,
        );
      }
      return active.id;
    }

    const result = db
      .prepare(
        `INSERT OR IGNORE INTO parsing_queue (
           id, queue_kind, schema_version, job_id, provider, source_hash, listing_id,
           external_id, source_url, discovered_at, capture_json, stage, status,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'captured', 'pending', ?, ?)`,
      )
      .run(
        queueId,
        queueKind,
        PIPELINE_SCHEMA_VERSION,
        jobId,
        provider,
        sourceHash,
        listingId ?? null,
        capture.externalId ?? null,
        capture.sourceUrl ?? null,
        capture.discoveredAt ?? now,
        JSON.stringify(capture),
        now,
        now,
      );

    let resolvedQueueId = queueId;
    if (result.changes === 0) {
      const existing = db
        .prepare(
          `SELECT id, status FROM parsing_queue
           WHERE queue_kind = ? AND job_id = ? AND provider = ? AND source_hash = ? AND schema_version = ?`,
        )
        .get(queueKind, jobId, provider, sourceHash, PIPELINE_SCHEMA_VERSION);
      if (!existing || existing.status !== 'cancelled') return existing?.id;
      resolvedQueueId = existing.id;
      db.prepare(
        `UPDATE parsing_queue SET listing_id = ?, external_id = ?, source_url = ?, discovered_at = ?,
           capture_json = ?, stage = 'captured', status = 'pending', attempt_count = 0,
           llm_attempt_count = 0, geocode_attempt_count = 0, lease_until = NULL,
           next_attempt_at = 0, last_error = NULL, updated_at = ?, completed_at = NULL
         WHERE id = ?`,
      ).run(
        listingId ?? null,
        capture.externalId ?? null,
        capture.sourceUrl ?? null,
        capture.discoveredAt ?? now,
        JSON.stringify(capture),
        now,
        resolvedQueueId,
      );
      db.prepare('DELETE FROM listing_images WHERE queue_id = ?').run(resolvedQueueId);
      db.prepare('DELETE FROM listing_extractions WHERE queue_id = ?').run(resolvedQueueId);
    }

    // A fresh capture under the current contract supersedes any unfinished
    // rows enqueued under an older schema version.
    db.prepare(
      `UPDATE parsing_queue
       SET status = 'cancelled', lease_until = NULL, completed_at = ?, updated_at = ?,
           last_error = 'Superseded by schema v' || ?
       WHERE queue_kind = ? AND job_id = ? AND provider = ? AND source_hash = ?
         AND schema_version < ? AND status IN ('pending', 'retry', 'processing')`,
    ).run(now, now, PIPELINE_SCHEMA_VERSION, queueKind, jobId, provider, sourceHash, PIPELINE_SCHEMA_VERSION);

    const imageStmt = db.prepare(
      `INSERT INTO listing_images (
         id, queue_id, listing_id, position, kind, original_url, storage_path,
         content_hash, mime_type, byte_size, width, height, download_status, error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const image of images) {
      imageStmt.run(
        nanoid(),
        resolvedQueueId,
        listingId ?? null,
        image.position,
        image.kind ?? 'photo',
        image.originalUrl ?? null,
        image.storagePath ?? null,
        image.contentHash ?? null,
        image.mimeType ?? null,
        image.byteSize ?? null,
        image.width ?? null,
        image.height ?? null,
        image.downloadStatus ?? 'failed',
        image.error ?? null,
      );
    }

    return resolvedQueueId;
  })();
  if (detailQueueId && effectiveQueueId) attachParsingQueue(detailQueueId, effectiveQueueId);
  return effectiveQueueId;
}

/**
 * Claim the next queue item the worker can actually serve right now.
 *
 * Interrupted live work is reclaimed first. Otherwise a persisted weighted
 * credit gives backfill bounded progress after each live item, while a new
 * live item can never wait behind more than the configured burst. Items that
 * still need LLM calls respect their budget; cached finalize-stage retries
 * remain claimable even while that budget is exhausted.
 *
 * @param {{now?: number, leaseMs?: number}} [options]
 * @returns {object|null} hydrated queue row or null when nothing is claimable
 */
export function claimNext({ now = Date.now(), leaseMs = DEFAULT_LEASE_MS } = {}) {
  const db = SqliteConnection.getConnection();
  const liveBudgetOk = canSpend('live', now).ok;
  const backfillBudgetOk = canSpend('backfill', now).ok;
  return db.transaction(() => {
    const backfillCredit = readControlInt(db, 'parser_backfill_credit');
    const backfillBurst = positiveEnv('FREDY_PARSER_BACKFILL_BURST', DEFAULT_BACKFILL_BURST);
    const backfillAllowed = !isBackfillPaused(db);

    let row = selectInterrupted(db, 'live', now, liveBudgetOk);
    if (!row && backfillAllowed) row = selectInterrupted(db, 'backfill', now, backfillBudgetOk);
    if (backfillCredit > 0 && backfillAllowed) {
      row ||= selectReady(db, 'backfill', now, backfillBudgetOk);
    }
    if (!row) row = selectReady(db, 'live', now, liveBudgetOk);
    if (!row && backfillAllowed) {
      row = selectReady(db, 'backfill', now, backfillBudgetOk);
    }
    if (!row) return null;

    const interrupted = row.status === 'processing' ? 1 : 0;
    const claimed = db
      .prepare(
        `UPDATE parsing_queue
         SET status = 'processing', lease_until = ?, attempt_count = attempt_count + ?,
             updated_at = ?, last_error = NULL
         WHERE id = ?
           AND status IN ('pending', 'retry', 'processing')
           AND (lease_until IS NULL OR lease_until < ?)`,
      )
      .run(now + leaseMs, interrupted, now, row.id, now);
    if (claimed.changes === 0) return null;

    // A reclaimed lease supersedes any attempt left open by an interrupted
    // process. Keep the history, but never leave more than one open attempt
    // for the same durable queue item.
    db.prepare(
      `UPDATE processing_attempts SET status = 'interrupted'
       WHERE queue_id = ? AND status = 'started'`,
    ).run(row.id);
    db.prepare(
      `INSERT INTO processing_attempts (queue_id, queue_kind, started_at, status)
       VALUES (?, ?, ?, 'started')`,
    ).run(row.id, row.queue_kind, now);
    const nextCredit = row.queue_kind === 'live' ? backfillBurst : Math.max(0, backfillCredit - 1);
    writeControlInt(db, 'parser_backfill_credit', nextCredit, now);

    return hydrateQueueRow(db.prepare('SELECT * FROM parsing_queue WHERE id = ?').get(row.id));
  })();
}

function selectInterrupted(db, kind, now, budgetOk) {
  return db
    .prepare(
      `SELECT q.* FROM parsing_queue q
       LEFT JOIN listing_extractions e ON e.queue_id = q.id
       WHERE q.queue_kind = ?
         AND q.schema_version = ${PIPELINE_SCHEMA_VERSION}
         AND q.status = 'processing'
         AND q.next_attempt_at <= ?
         AND q.lease_until < ?
         AND (? = 1 OR e.llm_json IS NOT NULL)
       ORDER BY q.discovered_at ASC
       LIMIT 1`,
    )
    .get(kind, now, now, budgetOk ? 1 : 0);
}

function selectReady(db, kind, now, budgetOk) {
  const order = kind === 'live' ? 'DESC' : 'ASC';
  return db
    .prepare(
      `SELECT q.* FROM parsing_queue q
       LEFT JOIN listing_extractions e ON e.queue_id = q.id
       WHERE q.queue_kind = ?
         AND q.schema_version = ${PIPELINE_SCHEMA_VERSION}
         AND q.status IN ('pending', 'retry', 'processing')
         AND q.next_attempt_at <= ?
         AND (q.lease_until IS NULL OR q.lease_until < ?)
         AND (? = 1 OR e.llm_json IS NOT NULL)
       ORDER BY q.discovered_at ${order}
       LIMIT 1`,
    )
    .get(kind, now, now, budgetOk ? 1 : 0);
}

export function saveExtraction(queueId, patch) {
  const db = SqliteConnection.getConnection();
  const queue = db.prepare('SELECT listing_id, schema_version FROM parsing_queue WHERE id = ?').get(queueId);
  if (!queue) return;
  const current = db.prepare('SELECT * FROM listing_extractions WHERE queue_id = ?').get(queueId) || {};
  const value = { ...current, ...patch };
  db.prepare(
    `INSERT INTO listing_extractions (
       queue_id, listing_id, schema_version, source_text,
       visual_json, llm_json, vision_model, text_model,
       vision_duration_ms, llm_duration_ms, parsed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(queue_id) DO UPDATE SET
       listing_id = excluded.listing_id,
       source_text = excluded.source_text,
       visual_json = excluded.visual_json,
       llm_json = excluded.llm_json,
       vision_model = excluded.vision_model,
       text_model = excluded.text_model,
       vision_duration_ms = excluded.vision_duration_ms,
       llm_duration_ms = excluded.llm_duration_ms,
       parsed_at = excluded.parsed_at`,
  ).run(
    queueId,
    value.listing_id ?? queue.listing_id ?? null,
    queue.schema_version,
    value.source_text ?? '',
    jsonOrNull(value.visual_json),
    jsonOrNull(value.llm_json),
    value.vision_model ?? null,
    value.text_model ?? null,
    value.vision_duration_ms ?? null,
    value.llm_duration_ms ?? null,
    value.parsed_at ?? null,
  );
}

export function getExtraction(queueId) {
  const row = SqliteConnection.getConnection()
    .prepare('SELECT * FROM listing_extractions WHERE queue_id = ?')
    .get(queueId);
  if (!row) return null;
  for (const key of ['visual_json', 'llm_json']) {
    row[key] = parseJson(row[key]);
  }
  return row;
}

export function getQueueImages(queueId) {
  return SqliteConnection.query(`SELECT * FROM listing_images WHERE queue_id = @queueId ORDER BY position ASC`, {
    queueId,
  });
}

export function updateQueueStage(queueId, stage, auditEvent = null) {
  const db = SqliteConnection.getConnection();
  db.transaction(() => {
    db.prepare('UPDATE parsing_queue SET stage = ?, updated_at = ? WHERE id = ?').run(stage, Date.now(), queueId);
    if (auditEvent) {
      auditQueueEvent(db, queueId, stage, auditEvent.action, auditEvent.reason, auditEvent.payload);
    }
  })();
}

/**
 * Record a genuine failure and schedule a retry. Increments the general
 * attempt counter (and the LLM counter when the failure happened in an LLM
 * stage) — this is the only place failure attempts are counted.
 *
 * @param {string} queueId
 * @param {Error|string} error
 * @param {{delayMs?: number, llm?: boolean}} [options]
 */
export function retryQueue(
  queueId,
  error,
  { delayMs = 60_000, llm = false, maxFailures = null, classification = null } = {},
) {
  if (llm && Number.isFinite(maxFailures)) {
    const row = SqliteConnection.getConnection()
      .prepare('SELECT llm_attempt_count FROM parsing_queue WHERE id = ?')
      .get(queueId);
    const nextLlmAttempt = Number(row?.llm_attempt_count || 0) + 1;
    if (nextLlmAttempt >= maxFailures) {
      failQueue(queueId, error, {
        stage: 'llm',
        llm: true,
        classification: { ...classification, attempts: nextLlmAttempt },
      });
      return { status: 'dead', attempts: nextLlmAttempt };
    }
  }
  const now = Date.now();
  const changed = SqliteConnection.execute(
    `UPDATE parsing_queue
     SET status = 'retry', lease_until = NULL, next_attempt_at = @nextAttempt,
         last_error = @error, updated_at = @now,
         attempt_count = attempt_count + 1,
         llm_attempt_count = llm_attempt_count + @llmIncrement
     WHERE id = @queueId AND status IN ('pending', 'retry', 'processing')`,
    {
      queueId,
      nextAttempt: now + delayMs,
      error: String(error?.message || error).slice(0, 2000),
      now,
      llmIncrement: llm ? 1 : 0,
    },
  );
  finishLatestAttempt(queueId, changed.changes ? 'retry' : 'cancelled');
  if (changed.changes) {
    auditQueueEvent(SqliteConnection.getConnection(), queueId, 'parse', 'retry', error, { llm, ...classification });
  }
  return { status: changed.changes ? 'retry' : 'unchanged' };
}

/** Permanently stop one exceptional parser item without affecting the worker. */
export function failQueue(queueId, error, { stage = 'parse', llm = false, classification = null } = {}) {
  const now = Date.now();
  SqliteConnection.withTransaction((db) => {
    const changed = db
      .prepare(
        `UPDATE parsing_queue
         SET status = 'dead', lease_until = NULL, completed_at = @now,
             updated_at = @now, last_error = @error,
             attempt_count = attempt_count + 1,
             llm_attempt_count = llm_attempt_count + @llmIncrement
         WHERE id = @queueId AND status IN ('pending', 'retry', 'processing')`,
      )
      .run({
        queueId,
        now,
        error: String(error?.message || error).slice(0, 2000),
        llmIncrement: llm ? 1 : 0,
      });
    finishLatestAttempt(queueId, changed.changes ? 'dead' : 'cancelled', db);
    if (changed.changes) auditQueueEvent(db, queueId, stage, 'failed', error, classification);
  });
}

/**
 * Park an item until a resource (LLM budget, geocoder) is available again.
 * Deferrals are not failures: no attempt counter is touched, so a listing
 * can wait for days without consuming failure attempts.
 *
 * @param {string} queueId
 * @param {string} reason human-readable wait reason, stored in last_error
 * @param {number} untilMs epoch ms at which the item becomes claimable again
 * @param {{geocode?: boolean}} [options] geocode deferrals count toward the
 *   geocode escape hatch that eventually allows missing coordinates
 */
export function deferQueue(queueId, reason, untilMs, { geocode = false } = {}) {
  const now = Date.now();
  const changed = SqliteConnection.execute(
    `UPDATE parsing_queue
     SET status = 'retry', lease_until = NULL, next_attempt_at = @nextAttempt,
         last_error = @reason, updated_at = @now,
         geocode_attempt_count = geocode_attempt_count + @geocodeIncrement
     WHERE id = @queueId AND status IN ('pending', 'retry', 'processing')`,
    {
      queueId,
      nextAttempt: Math.max(untilMs, now + 1000),
      reason: `Waiting: ${String(reason).slice(0, 1900)}`,
      now,
      geocodeIncrement: geocode ? 1 : 0,
    },
  );
  finishLatestAttempt(queueId, changed.changes ? 'deferred' : 'cancelled');
  if (changed.changes) {
    auditQueueEvent(SqliteConnection.getConnection(), queueId, 'parse', 'deferred', reason, { geocode });
  }
}

export function completeQueue(queueId, listingId, status = 'completed') {
  const now = Date.now();
  SqliteConnection.withTransaction((db) => {
    const changed = db
      .prepare(
        `UPDATE parsing_queue
       SET listing_id = COALESCE(?, listing_id), status = ?, stage = 'completed',
           lease_until = NULL, completed_at = ?, updated_at = ?
       WHERE id = ? AND (status != 'cancelled' OR ? = 'cancelled')`,
      )
      .run(listingId ?? null, status, now, now, queueId, status);
    if (!changed.changes) {
      finishLatestAttempt(queueId, 'cancelled', db);
      return;
    }
    if (listingId) {
      db.prepare('UPDATE listing_images SET listing_id = ? WHERE queue_id = ?').run(listingId, queueId);
      db.prepare('UPDATE listing_extractions SET listing_id = ? WHERE queue_id = ?').run(listingId, queueId);
      db.prepare('UPDATE llm_call_audit SET listing_id = COALESCE(listing_id, ?) WHERE queue_id = ?').run(
        listingId,
        queueId,
      );
    }
    finishLatestAttempt(queueId, status, db);
  });
}

export function setBackfillPaused(paused) {
  SqliteConnection.execute(
    `INSERT INTO pipeline_control (name, value, updated_at) VALUES ('backfill_paused', @value, @now)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { value: paused ? '1' : '0', now: Date.now() },
  );
}

export function getBackfillStatus() {
  const db = SqliteConnection.getConnection();
  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM parsing_queue
       WHERE queue_kind = 'backfill' GROUP BY status`,
    )
    .all();
  return {
    paused: isBackfillPaused(db),
    counts: Object.fromEntries(counts.map((row) => [row.status, row.count])),
    migration: db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN a.schema_version >= ? THEN 1 ELSE 0 END) AS migrated
         FROM listings l
         LEFT JOIN listing_attributes a ON a.listing_id = l.id`,
      )
      .get(PIPELINE_SCHEMA_VERSION),
    audit: db.prepare(`SELECT outcome, COUNT(*) AS count FROM llm_call_audit GROUP BY outcome`).all(),
    llmBudget: budgetStatus(),
  };
}

function isBackfillPaused(db) {
  return db.prepare("SELECT value FROM pipeline_control WHERE name = 'backfill_paused'").get()?.value === '1';
}

function readControlInt(db, name) {
  const parsed = Number.parseInt(
    db.prepare('SELECT value FROM pipeline_control WHERE name = ?').get(name)?.value || '',
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function writeControlInt(db, name, value, now) {
  db.prepare(
    `INSERT INTO pipeline_control (name, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(name, String(value), now);
}

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function finishLatestAttempt(queueId, status, suppliedDb) {
  const db = suppliedDb || SqliteConnection.getConnection();
  db.prepare(
    `UPDATE processing_attempts SET status = ?
     WHERE queue_id = ? AND status = 'started'`,
  ).run(status, queueId);
}

function auditQueueEvent(db, queueId, stage, action, reason, payload = null) {
  const hasAuditTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_audit_events'")
    .get();
  if (!hasAuditTable) return;
  db.prepare(
    `INSERT INTO pipeline_audit_events (
       source_id, listing_id, queue_id, stage, action, reason, payload_json, created_at
     ) VALUES (
       NULL,
       COALESCE(
         (SELECT listing_id FROM parsing_queue WHERE id = ?),
         (SELECT listing_id FROM listing_sources
          WHERE detail_queue_id = ? AND listing_id IS NOT NULL LIMIT 1)
       ),
       ?, ?, ?, ?, ?, ?
     )`,
  ).run(
    queueId,
    queueId,
    queueId,
    stage,
    action,
    String(reason?.message || reason || '').slice(0, 2000) || null,
    payload == null ? null : JSON.stringify(payload),
    Date.now(),
  );
}

function hydrateQueueRow(row) {
  if (!row) return null;
  return { ...row, capture: parseJson(row.capture_json) || {} };
}

function hydrateDetailRow(row) {
  if (!row) return null;
  return { ...row, discovery: parseJson(row.discovery_json) || {} };
}

function canonicalSourceUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value || '');
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function jsonOrNull(value) {
  if (value == null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseJson(value) {
  if (!value) return null;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}
