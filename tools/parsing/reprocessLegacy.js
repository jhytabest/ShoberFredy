/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * One-time, auditable reconciliation of genuine pre-pipeline history.
 *
 * Only rows carrying legacy_snapshot_json belong to this cohort. Ordinary
 * live discovery/detail/filter rejects stay in the production database.
 *
 *   node tools/parsing/reprocessLegacy.js          # read-only plan
 *   node tools/parsing/reprocessLegacy.js apply    # archive + enqueue
 */

import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import SqliteConnection from '../../lib/services/storage/SqliteConnection.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { refreshConfig } from '../../lib/utils.js';
import { getJob } from '../../lib/services/storage/jobStorage.js';
import { classifyHistoricalListing } from '../../lib/services/pipeline/legacyReprocess.js';
import { archivePreLlmListing } from '../../lib/services/pipeline/preLlmArchive.js';
import {
  enqueueCapture,
  getBackfillStatus,
  PIPELINE_SCHEMA_VERSION,
  setBackfillPaused,
} from '../../lib/services/pipeline/queueStorage.js';

const CONTRACT_VERSION = 3;

export function planHistoricalReconciliation(db = SqliteConnection.getConnection()) {
  const rows = db
    .prepare(
      `SELECT * FROM listings
       WHERE canonical_schema_version < ?
         AND legacy_snapshot_json IS NOT NULL
       ORDER BY created_at, id`,
    )
    .all(PIPELINE_SCHEMA_VERSION);
  const jobCache = new Map();
  const plan = [];
  for (const listing of rows) {
    const evidence = bestEvidence(db, listing);
    const job = cachedJob(jobCache, listing.job_id);
    const verdict = classifyHistoricalListing({
      db,
      listing,
      capture: evidence?.capture ?? null,
      discovery: evidence?.discovery ?? legacyDiscovery(listing),
      job,
    });
    plan.push({ listing, evidence, verdict });
  }
  return plan;
}

export function applyHistoricalReconciliation(db = SqliteConnection.getConnection()) {
  const runId = nanoid();
  const startedAt = Date.now();
  db.prepare(
    `INSERT INTO pre_llm_archive_runs (
       id, contract_version, status, started_at
     ) VALUES (?, ?, 'running', ?)`,
  ).run(runId, CONTRACT_VERSION, startedAt);

  const summary = newSummary();
  const plan = planHistoricalReconciliation(db);
  const wasPaused = getBackfillStatus().paused;
  setBackfillPaused(true);
  try {
    for (const item of plan) {
      countVerdict(summary, item.verdict);
      if (item.verdict.action === 'archive') {
        archivePreLlmListing(db, item.listing.id, {
          runId,
          reason: item.verdict.reason,
          classification: item.verdict,
        });
        summary.archived += 1;
      } else {
        enqueueHistoricalListing(db, item.listing, item.evidence, {
          purpose: 'legacy_migration',
          resetLegacyVisibility: true,
        });
        summary.migrated += 1;
      }
    }

    summary.repaired = requeueUnscorableBackfills(db);
    summary.deadRecovered = recoverDeadQueues(db);
    closeOpenAudits(db);
    db.prepare(
      `UPDATE pre_llm_archive_runs
       SET status = 'completed', completed_at = ?, archived_count = ?,
           migrated_count = ?, repaired_count = ?, summary_json = ?
       WHERE id = ?`,
    ).run(Date.now(), summary.archived, summary.migrated, summary.repaired, JSON.stringify(summary), runId);
    return { runId, ...summary };
  } catch (error) {
    db.prepare(
      `UPDATE pre_llm_archive_runs
       SET status = 'failed', completed_at = ?, archived_count = ?,
           migrated_count = ?, repaired_count = ?, summary_json = ?, error = ?
       WHERE id = ?`,
    ).run(
      Date.now(),
      summary.archived,
      summary.migrated,
      summary.repaired,
      JSON.stringify(summary),
      String(error?.stack || error).slice(0, 8000),
      runId,
    );
    throw error;
  } finally {
    setBackfillPaused(wasPaused);
  }
}

function enqueueHistoricalListing(db, listing, evidence, { purpose, resetLegacyVisibility = false }) {
  if (!evidence?.capture?.fullText?.trim()) {
    throw new Error(`Cannot enqueue historical listing '${listing.id}' without detail evidence`);
  }
  const capture = enrichedBackfillCapture(listing, evidence);
  const sourceHash = reconciliationSourceHash(listing.id, purpose);
  if (resetLegacyVisibility) {
    db.transaction(() => {
      db.prepare(
        `UPDATE listings
         SET manually_deleted = 0, hidden_reason = NULL, filter_reasons_json = '[]'
         WHERE id = ?`,
      ).run(listing.id);
      db.prepare('DELETE FROM listing_attributes WHERE listing_id = ?').run(listing.id);
    })();
  }
  const queueId = enqueueCapture({
    jobId: listing.job_id,
    provider: listing.provider,
    sourceHash,
    capture,
    images: [],
    queueKind: 'backfill',
    listingId: listing.id,
  });
  recordReconciliationAudit(db, listing.id, queueId, purpose, {
    contractVersion: CONTRACT_VERSION,
    sourceHash,
  });
  return queueId;
}

function requeueUnscorableBackfills(db) {
  const rows = db
    .prepare(
      `SELECT DISTINCT listing.*
       FROM rating_queue rating
       JOIN listings listing ON listing.id = rating.listing_id
       WHERE rating.status = 'waiting_model'
         AND listing.canonical_schema_version >= ?
         AND listing.legacy_snapshot_json IS NOT NULL
         AND (listing.price IS NULL OR listing.size IS NULL)
       ORDER BY listing.created_at, listing.id`,
    )
    .all(PIPELINE_SCHEMA_VERSION);
  let count = 0;
  for (const listing of rows) {
    const evidence = bestEvidence(db, listing);
    if (!evidence?.capture?.fullText?.trim()) continue;
    enqueueHistoricalListing(db, listing, evidence, { purpose: 'historical_evidence_repair' });
    count += 1;
  }
  return count;
}

function recoverDeadQueues(db) {
  const dead = db.prepare(`SELECT * FROM parsing_queue WHERE status = 'dead' ORDER BY created_at`).all();
  let count = 0;
  for (const queue of dead) {
    // Archived listings have already cascaded their queue away. Migrated
    // historical listings already have a replacement under contract v2.
    const replacement = queue.listing_id
      ? db
          .prepare(
            `SELECT id FROM parsing_queue
             WHERE listing_id = ? AND id != ? AND status IN ('pending', 'processing', 'retry')
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(queue.listing_id, queue.id)
      : null;
    if (!replacement) {
      const capture = parseJson(queue.capture_json, {});
      if (capture?.fullText?.trim()) {
        const listing = queue.listing_id
          ? db.prepare('SELECT * FROM listings WHERE id = ?').get(queue.listing_id)
          : null;
        const evidence = listing ? bestEvidence(db, listing) : { capture, discovery: capture.discoveryData || {} };
        if (listing && queue.queue_kind === 'backfill') {
          enqueueHistoricalListing(db, listing, evidence, { purpose: `dead_recovery_${queue.id}` });
        } else {
          const queueId = enqueueCapture({
            jobId: queue.job_id,
            provider: queue.provider,
            sourceHash: reconciliationSourceHash(queue.id, 'dead_live_recovery'),
            capture,
            images: [],
            queueKind: queue.queue_kind,
            listingId: queue.listing_id,
            detailQueueId: sourceDetailQueueId(db, queue.id),
          });
          recordReconciliationAudit(db, queue.listing_id, queueId, 'dead_queue_recovery', {
            supersededQueueId: queue.id,
          });
        }
      }
    }
    db.prepare(
      `UPDATE parsing_queue
       SET status = 'cancelled', lease_until = NULL, completed_at = ?,
           updated_at = ?, last_error = ?
       WHERE id = ? AND status = 'dead'`,
    ).run(Date.now(), Date.now(), 'Superseded by audited reconciliation', queue.id);
    db.prepare(
      `UPDATE processing_attempts SET status = 'superseded'
       WHERE queue_id = ? AND status = 'started'`,
    ).run(queue.id);
    recordReconciliationAudit(db, queue.listing_id, queue.id, 'dead_queue_cleared', {
      previousError: queue.last_error,
    });
    count += 1;
  }
  return count;
}

function closeOpenAudits(db) {
  const now = Date.now();
  db.prepare(
    `UPDATE processing_attempts SET status = 'interrupted'
     WHERE status = 'started'
       AND NOT EXISTS (
         SELECT 1 FROM parsing_queue queue
         WHERE queue.id = processing_attempts.queue_id
           AND queue.status = 'processing'
       )`,
  ).run();
  db.prepare(
    `UPDATE llm_call_audit
     SET outcome = 'interrupted', completed_at = COALESCE(completed_at, ?),
         error = COALESCE(error, 'Closed by historical reconciliation')
     WHERE outcome = 'started'`,
  ).run(now);
}

function bestEvidence(db, listing) {
  const source = db
    .prepare(
      `SELECT capture_json, discovery_json, last_seen_at AS captured_at
       FROM listing_sources
       WHERE listing_id = ? AND capture_json IS NOT NULL
       ORDER BY last_seen_at DESC LIMIT 1`,
    )
    .get(listing.id);
  const queue = db
    .prepare(
      `SELECT capture_json, updated_at AS captured_at
       FROM parsing_queue
       WHERE listing_id = ? AND capture_json IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(listing.id);
  const candidates = [
    source && {
      capture: parseJson(source.capture_json, null),
      discovery: parseJson(source.discovery_json, null),
      capturedAt: source.captured_at,
    },
    queue && {
      capture: parseJson(queue.capture_json, null),
      discovery: parseJson(queue.capture_json, {})?.discoveryData,
      capturedAt: queue.captured_at,
    },
  ]
    .filter((candidate) => candidate?.capture?.fullText?.trim())
    .sort(
      (left, right) =>
        evidenceQuality(right.capture) - evidenceQuality(left.capture) ||
        Number(right.capturedAt || 0) - Number(left.capturedAt || 0),
    );
  const best = candidates[0];
  if (!best) return null;
  return {
    capture: best.capture,
    discovery: fillMissing(best.discovery || best.capture.discoveryData || {}, legacyDiscovery(listing)),
  };
}

function evidenceQuality(capture) {
  const embedded = Array.isArray(capture?.embeddedData) ? capture.embeddedData.length : 0;
  return Number(embedded > 0) * 1_000_000 + String(capture?.fullText || '').length;
}

function enrichedBackfillCapture(listing, evidence) {
  const legacySnapshot = parseJson(listing.legacy_snapshot_json, {}) || {};
  const discoveryData = fillMissing(
    evidence.discovery || evidence.capture.discoveryData || {},
    legacyDiscovery(listing),
    legacySnapshot,
  );
  return {
    ...evidence.capture,
    provider: evidence.capture.provider || listing.provider,
    externalId: evidence.capture.externalId || listing.hash,
    sourceUrl: evidence.capture.sourceUrl || listing.link,
    discoveredAt: evidence.capture.discoveredAt || listing.created_at || Date.now(),
    discoveryData,
    legacySnapshot,
    images: [],
    backfillEvidenceContract: CONTRACT_VERSION,
  };
}

function legacyDiscovery(listing) {
  const snapshot = parseJson(listing.legacy_snapshot_json, {}) || {};
  return fillMissing(snapshot, {
    id: listing.hash,
    link: listing.link,
    title: listing.title,
    price: listing.price,
    size: listing.size,
    rooms: listing.rooms,
    address: listing.address,
    image: listing.image_url,
    description: listing.description,
  });
}

function fillMissing(primary, ...fallbacks) {
  const result = { ...(primary || {}) };
  for (const fallback of fallbacks) {
    for (const [key, value] of Object.entries(fallback || {})) {
      if (result[key] == null || result[key] === '') result[key] = value;
    }
  }
  return result;
}

function reconciliationSourceHash(id, purpose) {
  return crypto.createHash('sha256').update(`historical-backfill-v${CONTRACT_VERSION}:${purpose}:${id}`).digest('hex');
}

function sourceDetailQueueId(db, parsingQueueId) {
  return db
    .prepare(
      `SELECT detail_queue_id FROM listing_sources
       WHERE parsing_queue_id = ? AND detail_queue_id IS NOT NULL
       ORDER BY first_seen_at LIMIT 1`,
    )
    .get(parsingQueueId)?.detail_queue_id;
}

function recordReconciliationAudit(db, listingId, queueId, action, payload) {
  db.prepare(
    `INSERT INTO pipeline_audit_events (
       source_id, listing_id, queue_id, stage, action, reason, payload_json, created_at
     ) VALUES (NULL, ?, ?, 'historical_reconciliation', ?, NULL, ?, ?)`,
  ).run(listingId ?? null, queueId ?? null, action, JSON.stringify(payload || {}), Date.now());
}

function cachedJob(cache, jobId) {
  if (!cache.has(jobId)) {
    try {
      cache.set(jobId, getJob(jobId));
    } catch {
      cache.set(jobId, null);
    }
  }
  return cache.get(jobId);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || '') ?? fallback;
  } catch {
    return fallback;
  }
}

function newSummary() {
  return {
    total: 0,
    archived: 0,
    migrated: 0,
    repaired: 0,
    deadRecovered: 0,
    byAction: {},
    byReason: {},
    byGeoState: {},
    byGeoPrecision: {},
  };
}

function countVerdict(summary, verdict) {
  summary.total += 1;
  increment(summary.byAction, verdict.action);
  increment(summary.byReason, verdict.reason || 'eligible');
  increment(summary.byGeoState, verdict.geoState || 'unknown');
  increment(summary.byGeoPrecision, verdict.geoPrecision || 'none');
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function summarizePlan(plan) {
  const summary = newSummary();
  for (const { verdict } of plan) countVerdict(summary, verdict);
  summary.archived = summary.byAction.archive || 0;
  summary.migrated = summary.byAction.migrate || 0;
  return summary;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const apply = process.argv[2] === 'apply';
  await SqliteConnection.init();
  await refreshConfig();
  await runMigrations();
  const result = apply
    ? applyHistoricalReconciliation()
    : { mode: 'dry-run', ...summarizePlan(planHistoricalReconciliation()) };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  SqliteConnection.close();
}
