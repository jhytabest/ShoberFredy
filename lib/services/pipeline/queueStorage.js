/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import SqliteConnection from '../storage/SqliteConnection.js';
import { canSpend, budgetStatus } from './llmBudget.js';
import { PIPELINE_SCHEMA_VERSION } from './pipelineVersion.js';
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
  const sourceUrl = canonicalSourceUrl(listing.link);
  const sourceKey = String(listing.externalId || sourceUrl);
  const discoveryJson = JSON.stringify(listing);
  const discoveryHash = sha256(discoveryJson);
  const existing = db
    .prepare(
      'SELECT id, discovery_hash, status FROM detail_fetch_queue WHERE job_id = ? AND provider = ? AND source_key = ?',
    )
    .get(jobId, provider, sourceKey);
  if (!existing) {
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
    return { id, changed: true };
  }
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
}

export function claimDetail({ jobId, provider, now = Date.now(), leaseMs = DEFAULT_LEASE_MS }) {
  const db = SqliteConnection.getConnection();
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT * FROM detail_fetch_queue
         WHERE job_id = ? AND provider = ?
           AND status IN ('pending', 'retry', 'processing')
           AND next_attempt_at <= ?
           AND (lease_until IS NULL OR lease_until < ?)
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(jobId, provider, now, now);
    if (!row) return null;
    const interrupted = row.status === 'processing' ? 1 : 0;
    const claimed = db
      .prepare(
        `UPDATE detail_fetch_queue
         SET status = 'processing', lease_until = ?, attempt_count = attempt_count + ?,
             updated_at = ?, last_error = NULL
         WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)`,
      )
      .run(now + leaseMs, interrupted, now, row.id, now);
    if (!claimed.changes) return null;
    return hydrateDetailRow(db.prepare('SELECT * FROM detail_fetch_queue WHERE id = ?').get(row.id));
  })();
}

export function retryDetail(id, error, { delayMs = 60_000 } = {}) {
  const now = Date.now();
  SqliteConnection.execute(
    `UPDATE detail_fetch_queue
     SET status = 'retry', attempt_count = attempt_count + 1, lease_until = NULL,
         next_attempt_at = @nextAttemptAt, last_error = @error, updated_at = @now
     WHERE id = @id`,
    {
      id,
      nextAttemptAt: now + delayMs,
      error: String(error?.message || error).slice(0, 2000),
      now,
    },
  );
}

export function completeDetail(id, captureQueueId) {
  const now = Date.now();
  SqliteConnection.execute(
    `UPDATE detail_fetch_queue
     SET status = 'completed', capture_queue_id = @captureQueueId,
         lease_until = NULL, completed_at = @now, updated_at = @now
     WHERE id = @id`,
    { id, captureQueueId, now },
  );
}

export function markDetailInactive(id, reason, capture) {
  const now = Date.now();
  SqliteConnection.execute(
    `UPDATE detail_fetch_queue
     SET status = 'inactive', lease_until = NULL, completed_at = @now,
         updated_at = @now, last_error = @reason, capture_json = @captureJson
     WHERE id = @id`,
    {
      id,
      now,
      reason: String(reason || 'Provider marks listing inactive').slice(0, 2000),
      captureJson: capture == null ? null : JSON.stringify(capture),
    },
  );
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

export function isKnownSource(jobId, provider, sourceHash) {
  const db = SqliteConnection.getConnection();
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM listings
         WHERE job_id = ? AND provider = ? AND hash = ?
         UNION ALL
         SELECT 1
         FROM parsing_queue
         WHERE job_id = ? AND provider = ? AND source_hash = ?
           AND status != 'cancelled'
         LIMIT 1`,
      )
      .get(jobId, provider, sourceHash, jobId, provider, sourceHash),
  );
}

export function enqueueCapture({ jobId, provider, sourceHash, capture, images = [], queueKind = 'live', listingId }) {
  const db = SqliteConnection.getConnection();
  const now = Date.now();
  const queueId = nanoid();

  return db.transaction(() => {
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

    let effectiveQueueId = queueId;
    if (result.changes === 0) {
      const existing = db
        .prepare(
          `SELECT id, status FROM parsing_queue
           WHERE queue_kind = ? AND job_id = ? AND provider = ? AND source_hash = ? AND schema_version = ?`,
        )
        .get(queueKind, jobId, provider, sourceHash, PIPELINE_SCHEMA_VERSION);
      if (!existing || existing.status !== 'cancelled') return existing?.id;
      effectiveQueueId = existing.id;
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
        effectiveQueueId,
      );
      db.prepare('DELETE FROM listing_images WHERE queue_id = ?').run(effectiveQueueId);
      db.prepare('DELETE FROM listing_extractions WHERE queue_id = ?').run(effectiveQueueId);
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
        effectiveQueueId,
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

    return effectiveQueueId;
  })();
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
       ORDER BY q.discovered_at ASC
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

export function updateQueueImage(imageId, image) {
  SqliteConnection.execute(
    `UPDATE listing_images SET
       storage_path = @storagePath, content_hash = @contentHash, mime_type = @mimeType,
       byte_size = @byteSize, width = @width, height = @height,
       download_status = @downloadStatus, error = @error
     WHERE id = @imageId`,
    {
      imageId,
      storagePath: image.storagePath ?? null,
      contentHash: image.contentHash ?? null,
      mimeType: image.mimeType ?? null,
      byteSize: image.byteSize ?? null,
      width: image.width ?? null,
      height: image.height ?? null,
      downloadStatus: image.downloadStatus ?? 'failed',
      error: image.error ?? null,
    },
  );
}

export function updateQueueStage(queueId, stage) {
  SqliteConnection.execute(`UPDATE parsing_queue SET stage = @stage, updated_at = @now WHERE id = @queueId`, {
    queueId,
    stage,
    now: Date.now(),
  });
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
export function retryQueue(queueId, error, { delayMs = 60_000, llm = false } = {}) {
  const now = Date.now();
  SqliteConnection.execute(
    `UPDATE parsing_queue
     SET status = 'retry', lease_until = NULL, next_attempt_at = @nextAttempt,
         last_error = @error, updated_at = @now,
         attempt_count = attempt_count + 1,
         llm_attempt_count = llm_attempt_count + @llmIncrement
     WHERE id = @queueId`,
    {
      queueId,
      nextAttempt: now + delayMs,
      error: String(error?.message || error).slice(0, 2000),
      now,
      llmIncrement: llm ? 1 : 0,
    },
  );
  finishLatestAttempt(queueId, 'retry');
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
  SqliteConnection.execute(
    `UPDATE parsing_queue
     SET status = 'retry', lease_until = NULL, next_attempt_at = @nextAttempt,
         last_error = @reason, updated_at = @now,
         geocode_attempt_count = geocode_attempt_count + @geocodeIncrement
     WHERE id = @queueId`,
    {
      queueId,
      nextAttempt: Math.max(untilMs, now + 1000),
      reason: `Waiting: ${String(reason).slice(0, 1900)}`,
      now,
      geocodeIncrement: geocode ? 1 : 0,
    },
  );
  finishLatestAttempt(queueId, 'deferred');
}

export function completeQueue(queueId, listingId, status = 'completed') {
  const now = Date.now();
  SqliteConnection.withTransaction((db) => {
    db.prepare(
      `UPDATE parsing_queue
       SET listing_id = COALESCE(?, listing_id), status = ?, stage = 'completed',
           lease_until = NULL, completed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(listingId ?? null, status, now, now, queueId);
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
     WHERE id = (SELECT id FROM processing_attempts WHERE queue_id = ? ORDER BY id DESC LIMIT 1)`,
  ).run(status, queueId);
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
