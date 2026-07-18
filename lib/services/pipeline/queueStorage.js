/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { nanoid } from 'nanoid';
import SqliteConnection from '../storage/SqliteConnection.js';

export const PIPELINE_SCHEMA_VERSION = 1;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;

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
           AND status NOT IN ('dead', 'cancelled')
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
      if (!existing || !['dead', 'cancelled'].includes(existing.status) || queueKind !== 'live') return existing?.id;
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

export function claimNext({ now = Date.now(), leaseMs = DEFAULT_LEASE_MS } = {}) {
  const db = SqliteConnection.getConnection();
  return db.transaction(() => {
    let row = selectReady(db, 'live', now);
    if (!row && !isBackfillPaused(db) && backfillWithinLimits(db, now)) {
      row = selectReady(db, 'backfill', now);
    }
    if (!row) return null;

    const claimed = db
      .prepare(
        `UPDATE parsing_queue
         SET status = 'processing', lease_until = ?, attempt_count = attempt_count + 1,
             updated_at = ?, last_error = NULL
         WHERE id = ?
           AND status IN ('pending', 'retry', 'processing')
           AND (lease_until IS NULL OR lease_until < ?)`,
      )
      .run(now + leaseMs, now, row.id, now);
    if (claimed.changes === 0) return null;

    db.prepare(
      `INSERT INTO processing_attempts (queue_id, queue_kind, started_at, status)
       VALUES (?, ?, ?, 'started')`,
    ).run(row.id, row.queue_kind, now);

    return hydrateQueueRow(db.prepare('SELECT * FROM parsing_queue WHERE id = ?').get(row.id));
  })();
}

function selectReady(db, kind, now) {
  return db
    .prepare(
      `SELECT * FROM parsing_queue
       WHERE queue_kind = ?
         AND status IN ('pending', 'retry', 'processing')
         AND next_attempt_at <= ?
         AND (lease_until IS NULL OR lease_until < ?)
       ORDER BY discovered_at ASC
       LIMIT 1`,
    )
    .get(kind, now, now);
}

function backfillWithinLimits(db, now) {
  const perMinute = positiveEnv('FREDY_BACKFILL_MAX_PER_MINUTE', 10);
  const perDay = positiveEnv('FREDY_BACKFILL_MAX_PER_DAY', 500);
  const minuteCount = db
    .prepare(
      `SELECT COUNT(*) AS count FROM processing_attempts
       WHERE queue_kind = 'backfill' AND started_at > ?`,
    )
    .get(now - 60_000).count;
  const dayCount = db
    .prepare(
      `SELECT COUNT(*) AS count FROM processing_attempts
       WHERE queue_kind = 'backfill' AND started_at >= ?`,
    )
    .get(utcDayStart(now)).count;
  return minuteCount < perMinute && dayCount < perDay;
}

export function saveExtraction(queueId, patch) {
  const db = SqliteConnection.getConnection();
  const queue = db.prepare('SELECT listing_id, schema_version FROM parsing_queue WHERE id = ?').get(queueId);
  if (!queue) return;
  const current = db.prepare('SELECT * FROM listing_extractions WHERE queue_id = ?').get(queueId) || {};
  const value = { ...current, ...patch };
  db.prepare(
    `INSERT INTO listing_extractions (
       queue_id, listing_id, schema_version, source_text, deterministic_json,
       visual_json, llm_json, parser_mode, vision_model, text_model,
       vision_duration_ms, llm_duration_ms, parsed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(queue_id) DO UPDATE SET
       listing_id = excluded.listing_id,
       source_text = excluded.source_text,
       deterministic_json = excluded.deterministic_json,
       visual_json = excluded.visual_json,
       llm_json = excluded.llm_json,
       parser_mode = excluded.parser_mode,
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
    jsonOrNull(value.deterministic_json),
    jsonOrNull(value.visual_json),
    jsonOrNull(value.llm_json),
    value.parser_mode ?? null,
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
  for (const key of ['deterministic_json', 'visual_json', 'llm_json']) {
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

export function retryQueue(queueId, error, { delayMs = 60_000, llm = false, geocode = false } = {}) {
  const now = Date.now();
  SqliteConnection.execute(
    `UPDATE parsing_queue
     SET status = 'retry', lease_until = NULL, next_attempt_at = @nextAttempt,
         last_error = @error, updated_at = @now,
         llm_attempt_count = llm_attempt_count + @llmIncrement,
         geocode_attempt_count = geocode_attempt_count + @geocodeIncrement
     WHERE id = @queueId`,
    {
      queueId,
      nextAttempt: now + delayMs,
      error: String(error?.message || error).slice(0, 2000),
      now,
      llmIncrement: llm ? 1 : 0,
      geocodeIncrement: geocode ? 1 : 0,
    },
  );
  finishLatestAttempt(queueId, 'retry');
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
    }
    finishLatestAttempt(queueId, status, db);
  });
}

export function markQueueDead(queueId, error) {
  const now = Date.now();
  SqliteConnection.execute(
    `UPDATE parsing_queue SET status = 'dead', lease_until = NULL, last_error = @error,
       updated_at = @now, completed_at = @now WHERE id = @queueId`,
    { queueId, error: String(error?.message || error).slice(0, 2000), now },
  );
  finishLatestAttempt(queueId, 'dead');
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
  };
}

function isBackfillPaused(db) {
  return db.prepare("SELECT value FROM pipeline_control WHERE name = 'backfill_paused'").get()?.value === '1';
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

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function utcDayStart(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
