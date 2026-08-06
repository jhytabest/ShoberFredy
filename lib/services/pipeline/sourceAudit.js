/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import SqliteConnection from '../storage/SqliteConnection.js';
import { getJob } from '../storage/jobStorage.js';
import {
  canonicalUrl,
  claimsFromDedupeKeys,
  providerListingIdentity,
  recordSourceClaims,
  resolveClaims,
} from '../listings/claims.js';
import { cancelWork, cancelWorkForListing, getWork, patchWorkPayload } from './workQueue.js';
import { ACCEPTED_SQL } from './terminalVerdict.js';

export function recordDiscoverySource(
  db,
  { jobId, provider, sourceKey, sourceUrl, detailQueueId, listing, discoveryHash, dedupeKeys = [] },
) {
  const now = Date.now();
  let source = db
    .prepare('SELECT * FROM listing_sources WHERE job_id = ? AND provider = ? AND source_key = ?')
    .get(jobId, provider, sourceKey);
  if (!source) {
    const id = nanoid();
    db.prepare(
      `INSERT INTO listing_sources (
         id, job_id, provider, source_key, source_url, detail_queue_id,
         dedupe_keys_json, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, jobId, provider, sourceKey, sourceUrl, detailQueueId, JSON.stringify(dedupeKeys), now, now);
    source = db.prepare('SELECT * FROM listing_sources WHERE id = ?').get(id);
  } else {
    const storedKeys = parseJson(source.dedupe_keys_json || '[]');
    const mergedKeys = [...new Set([...(Array.isArray(storedKeys) ? storedKeys : []), ...dedupeKeys])];
    db.prepare(
      `UPDATE listing_sources
       SET source_url = ?, detail_queue_id = COALESCE(?, detail_queue_id),
           dedupe_keys_json = ?, last_seen_at = ?
       WHERE id = ?`,
    ).run(sourceUrl, detailQueueId, JSON.stringify(mergedKeys), now, source.id);
    source = db.prepare('SELECT * FROM listing_sources WHERE id = ?').get(source.id);
  }
  recordObservation(db, source.id, 'discovery', discoveryHash, listing, now);
  return source;
}

export function findDiscoveryRepresentative(db, { provider, sourceKey, sourceUrl, dedupeKeys }) {
  if (!dedupeKeys.length && !sourceUrl) return null;
  const matchedKey = db
    .prepare(
      `SELECT s.*
       FROM listing_sources s, json_each(s.dedupe_keys_json) known
       WHERE NOT (s.provider = ? AND s.source_key = ?)
         AND known.value IN (SELECT value FROM json_each(?))
         AND s.detail_queue_id IS NOT NULL
       ORDER BY s.first_seen_at ASC
       LIMIT 1`,
    )
    .get(provider, sourceKey, JSON.stringify(dedupeKeys));
  if (matchedKey) return matchedKey;

  const canonicalUrls = canonicalSourceUrls([sourceUrl, ...urlKeys(dedupeKeys)]);
  if (!canonicalUrls.size) return null;
  return db
    .prepare(
      `SELECT s.*
       FROM listing_sources s
       WHERE s.provider = ? AND s.source_key != ?
         AND s.detail_queue_id IS NOT NULL
       ORDER BY s.first_seen_at ASC`,
    )
    .all(provider, sourceKey)
    .find((source) => canonicalUrls.has(canonicalUrl(source.source_url)));
}

export function markDiscoveryDuplicate(db, sourceId, representative) {
  db.prepare(
    `UPDATE listing_sources
     SET representative_source_id = ?, dedupe_stage = 'discovery',
         detail_queue_id = ?, parsing_queue_id = ?, listing_id = ?
     WHERE id = ?`,
  ).run(
    representative.id,
    representative.detail_queue_id,
    representative.parsing_queue_id,
    representative.listing_id,
    sourceId,
  );
  audit(db, {
    sourceId,
    listingId: representative.listing_id,
    queueId: representative.detail_queue_id,
    stage: 'discovery_dedupe',
    action: 'merged',
    reason: `Representative source ${representative.id}`,
  });
  if (representative.parsing_queue_id) mergeLinksIntoParsingQueue(db, representative.parsing_queue_id);
}

export function recordDetailCapture(detail, capture, dedupeKeys) {
  const db = SqliteConnection.getConnection();
  const now = Date.now();
  const payload = JSON.stringify(capture);
  const contentHash = sha256(payload);
  db.transaction(() => {
    const sources = db.prepare('SELECT id FROM listing_sources WHERE detail_queue_id = ?').all(detail.id);
    for (const source of sources) {
      db.prepare(
        `UPDATE listing_sources
         SET dedupe_keys_json = ?, last_seen_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(dedupeKeys), now, source.id);
      recordObservation(db, source.id, 'detail', contentHash, capture, now);
      audit(db, { sourceId: source.id, queueId: detail.id, stage: 'detail', action: 'captured' });
    }
  })();
}

export function findDetailRepresentative(detail, dedupeKeys) {
  if (!dedupeKeys.length) return null;
  const db = SqliteConnection.getConnection();
  const matchedKey = db
    .prepare(
      `SELECT s.*
       FROM listing_sources s, json_each(s.dedupe_keys_json) known
       WHERE NOT (s.provider = ? AND s.source_key = ?)
         AND known.value IN (SELECT value FROM json_each(?))
         AND (s.representative_source_id IS NULL OR s.representative_source_id = s.id)
         AND (s.parsing_queue_id IS NOT NULL OR s.listing_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM source_rejections r WHERE r.source_id = s.id))
       ORDER BY s.first_seen_at ASC
       LIMIT 1`,
    )
    .get(detail.provider, detail.source_key, JSON.stringify(dedupeKeys));
  if (matchedKey) return matchedKey;
  return storedClaimRepresentative(db, detail, dedupeKeys);
}

function storedClaimRepresentative(db, detail, dedupeKeys) {
  const claims = claimsFromDedupeKeys(dedupeKeys).filter(
    ({ kind }) => kind === 'url' || kind === 'pid' || kind === 'img',
  );
  const listingIds = [
    ...new Set(
      resolveClaims(db, claims)
        .map((match) => match.listing_id)
        .filter(Boolean),
    ),
  ];
  if (!listingIds.length) return null;
  return (
    db
      .prepare(
        `SELECT s.*
         FROM listing_sources s
         JOIN listings l ON l.id = s.listing_id
         WHERE s.listing_id IN (SELECT value FROM json_each(?))
           AND NOT (s.provider = ? AND s.source_key = ?)
           AND (s.representative_source_id IS NULL OR s.representative_source_id = s.id)
         ORDER BY
           CASE WHEN ${ACCEPTED_SQL('l')} THEN 0 ELSE 1 END,
           s.first_seen_at ASC
         LIMIT 1`,
      )
      .get(JSON.stringify(listingIds), detail.provider, detail.source_key) || null
  );
}

export function mergeDetailSources(detailQueueId, representative) {
  const db = SqliteConnection.getConnection();
  const now = Date.now();
  db.transaction(() => {
    const sources = db.prepare('SELECT * FROM listing_sources WHERE detail_queue_id = ?').all(detailQueueId);
    for (const source of sources) {
      db.prepare(
        `UPDATE listing_sources
         SET representative_source_id = ?, dedupe_stage = 'detail',
             parsing_queue_id = ?, listing_id = ?, last_seen_at = ?
         WHERE id = ?`,
      ).run(representative.id, representative.parsing_queue_id, representative.listing_id, now, source.id);
      audit(db, {
        sourceId: source.id,
        listingId: representative.listing_id,
        queueId: detailQueueId,
        stage: 'detail_dedupe',
        action: 'merged',
        reason: `Representative source ${representative.id}`,
      });
    }
    if (representative.parsing_queue_id) mergeLinksIntoParsingQueue(db, representative.parsing_queue_id);
  })();
  return {
    parsingQueueId: representative.parsing_queue_id,
    listingId: representative.listing_id,
    rejected: Boolean(db.prepare('SELECT 1 FROM source_rejections WHERE source_id = ?').get(representative.id)),
  };
}

export function attachParsingQueue(detailQueueId, parsingQueueId) {
  const db = SqliteConnection.getConnection();
  db.transaction(() => {
    db.prepare('UPDATE listing_sources SET parsing_queue_id = ? WHERE detail_queue_id = ?').run(
      parsingQueueId,
      detailQueueId,
    );
    mergeLinksIntoParsingQueue(db, parsingQueueId);
    const sources = db.prepare('SELECT id FROM listing_sources WHERE detail_queue_id = ?').all(detailQueueId);
    for (const source of sources) {
      audit(db, { sourceId: source.id, queueId: parsingQueueId, stage: 'pre_llm', action: 'enqueued' });
    }
  })();
}

export function recordSourceRejection(
  detail,
  {
    reason,
    reasonTerm = null,
    stage,
    evidenceKind,
    evidenceHash = null,
    configHash,
    captureHash = null,
    reasons = [],
    queue = 'detail',
  },
) {
  const db = SqliteConnection.getConnection();
  const now = Date.now();
  const column = queue === 'parse' ? 'parsing_queue_id' : 'detail_queue_id';
  return db.transaction(() => {
    const sources = db.prepare(`SELECT * FROM listing_sources WHERE ${column} = ?`).all(detail.id);
    if (!sources.length) return null;
    const upsert = db.prepare(
      `INSERT INTO source_rejections
         (source_id, reason, reason_term, stage, config_hash, evidence_kind, evidence_hash, capture_hash,
          decided_at, decided_count, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         reason = excluded.reason, reason_term = excluded.reason_term, stage = excluded.stage,
         config_hash = excluded.config_hash,
         evidence_kind = excluded.evidence_kind, evidence_hash = excluded.evidence_hash,
         capture_hash = COALESCE(excluded.capture_hash, capture_hash),
         decided_count = decided_count + 1, last_seen_at = excluded.last_seen_at`,
    );
    for (const source of sources) {
      upsert.run(source.id, reason, reasonTerm, stage, configHash, evidenceKind, evidenceHash, captureHash, now, now);
      db.prepare(
        `UPDATE listing_sources
         SET dedupe_stage = COALESCE(dedupe_stage, ?), last_seen_at = ?
         WHERE id = ?`,
      ).run(stage === 'discovery' ? 'discovery' : 'pre_llm', now, source.id);
      audit(db, {
        sourceId: source.id,
        queueId: detail.id,
        stage: `${stage}_filter`,
        action: 'rejected',
        reason,
        payload: { reasons },
      });
      recordSourceClaims(db, source.id, identityClaims([source]), now);
    }
    cancelWork(queue, detail.id, reason, { outcome: 'filtered', code: 'filtered' });
    return sources[0].id;
  })();
}

export function cancelAllWorkForListing(listingId, reason = 'Listing filtered') {
  if (!listingId) return;
  const db = SqliteConnection.getConnection();
  db.transaction(() => cancelListingWork(db, listingId, reason, Date.now()))();
}

export function attachSourcesToListing(parsingQueueId, listingId, reason = null, dedupeStage = null) {
  if (!parsingQueueId || !listingId) return;
  const db = SqliteConnection.getConnection();
  const now = Date.now();
  db.transaction(() => {
    const sources = db.prepare('SELECT * FROM listing_sources WHERE parsing_queue_id = ?').all(parsingQueueId);
    for (const source of sources) {
      db.prepare(
        `UPDATE listing_sources
         SET listing_id = ?, dedupe_stage = COALESCE(?, dedupe_stage), last_seen_at = ?
         WHERE id = ?`,
      ).run(listingId, dedupeStage, now, source.id);
      audit(db, {
        sourceId: source.id,
        listingId,
        queueId: parsingQueueId,
        stage: dedupeStage === 'final' ? 'final_dedupe' : 'extraction_filter',
        action: dedupeStage === 'final' ? 'merged' : reason ? 'rejected' : 'accepted',
        reason,
      });
    }
  })();
}

export function jobsForDetailQueue(detailQueueId) {
  return jobsFor('detail_queue_id', detailQueueId);
}

export function jobsForParsingQueue(parsingQueueId) {
  return jobsFor('parsing_queue_id', parsingQueueId);
}

function jobsFor(column, queueId) {
  const rows = SqliteConnection.getConnection()
    .prepare(`SELECT DISTINCT job_id FROM listing_sources WHERE ${column} = ? ORDER BY job_id`)
    .all(queueId);
  return rows.map((row) => getJob(row.job_id)).filter(Boolean);
}

export function identityClaimsForParsingQueue(parsingQueueId) {
  return claimsForQueue('parsing_queue_id', parsingQueueId);
}

export function identityClaimsForDetailQueue(detailQueueId) {
  return claimsForQueue('detail_queue_id', detailQueueId);
}

function claimsForQueue(column, queueId) {
  const sources = SqliteConnection.getConnection()
    .prepare(`SELECT * FROM listing_sources WHERE ${column} = ?`)
    .all(queueId);
  return identityClaims(sources);
}

export function reusableExtraction(db, parsingQueueId, claims) {
  const listingIds = [
    ...new Set(
      resolveClaims(db, claims)
        .filter(({ kind }) => kind === 'cap' || kind === 'src' || kind === 'pid' || kind === 'url')
        .map((match) => match.listing_id)
        .filter(Boolean),
    ),
  ];
  if (!listingIds.length) return null;
  const row = db
    .prepare(
      `SELECT queue_id, llm_json, text_model FROM listing_extractions
       WHERE listing_id IN (SELECT value FROM json_each(?))
         AND queue_id != ? AND llm_json IS NOT NULL
       ORDER BY parsed_at DESC LIMIT 1`,
    )
    .get(JSON.stringify(listingIds), parsingQueueId);
  if (!row) return null;
  try {
    return { queue_id: row.queue_id, llm_json: JSON.parse(row.llm_json), text_model: row.text_model };
  } catch {
    return null;
  }
}

export function sourceLinksForParsingQueue(parsingQueueId) {
  const rows = SqliteConnection.getConnection()
    .prepare('SELECT source_url FROM listing_sources WHERE parsing_queue_id = ? ORDER BY first_seen_at')
    .all(parsingQueueId);
  return uniqueUrls(rows.map((row) => row.source_url));
}

export function sourceLinksForDetailQueue(detailQueueId) {
  const rows = SqliteConnection.getConnection()
    .prepare('SELECT source_url FROM listing_sources WHERE detail_queue_id = ? ORDER BY first_seen_at')
    .all(detailQueueId);
  return uniqueUrls(rows.map((row) => row.source_url));
}

export function recordListingAudit(listingId, { queueId = null, stage, action, reason = null, payload = null }) {
  if (!listingId) return;
  audit(SqliteConnection.getConnection(), { listingId, queueId, stage, action, reason, payload });
}

export function markSourcesInactive(detailQueueId, reason) {
  const db = SqliteConnection.getConnection();
  const now = Date.now();
  db.transaction(() => {
    const sources = db
      .prepare('SELECT id, listing_id FROM listing_sources WHERE detail_queue_id = ?')
      .all(detailQueueId);
    for (const source of sources) {
      audit(db, {
        sourceId: source.id,
        listingId: source.listing_id,
        queueId: detailQueueId,
        stage: 'detail',
        action: 'inactive',
        reason,
      });
    }
    const listingIds = [...new Set(sources.map((source) => source.listing_id).filter(Boolean))];
    for (const listingId of listingIds) {
      const stillListed = db
        .prepare(
          `SELECT 1 FROM listing_sources s
           WHERE s.listing_id = ? AND s.detail_queue_id IS NOT NULL AND s.detail_queue_id != ?
           LIMIT 1`,
        )
        .get(listingId, detailQueueId);
      if (stillListed) continue;
      db.prepare(`UPDATE listings SET state = 'gone', state_reason = ?, state_at = ? WHERE id = ?`).run(
        reason,
        now,
        listingId,
      );
    }
  })();
}

function mergeLinksIntoParsingQueue(db, parsingWorkKey) {
  const work = getWork('parse', parsingWorkKey);
  if (!work) return;
  const capture = work.payload?.capture;
  if (!capture) return;
  const sources = db
    .prepare('SELECT source_url FROM listing_sources WHERE parsing_queue_id = ? ORDER BY first_seen_at')
    .all(parsingWorkKey);
  capture.sourceLinks = uniqueUrls([...(capture.sourceLinks || []), ...sources.map((source) => source.source_url)]);
  patchWorkPayload('parse', parsingWorkKey, { capture });
}

function recordObservation(db, sourceId, stage, contentHash, payload, observedAt) {
  const payloadJson = JSON.stringify(payload);
  db.prepare(
    `INSERT OR IGNORE INTO listing_source_observations (
       id, source_id, stage, content_hash, content_bytes, observed_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(nanoid(), sourceId, stage, contentHash, Buffer.byteLength(payloadJson), observedAt);
}

function audit(db, { sourceId, listingId, queueId, stage, action, reason, payload }) {
  db.prepare(
    `INSERT INTO pipeline_audit_events (
       source_id, listing_id, queue_id, stage, action, reason, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sourceId ?? null,
    listingId ?? null,
    queueId ?? null,
    stage,
    action,
    reason ?? null,
    payload == null ? null : JSON.stringify(payload),
    Date.now(),
  );
}

function cancelListingWork(db, listingId, reason) {
  void db;
  cancelWorkForListing(listingId, reason);
}

function identityClaims(sources) {
  const claims = [];
  for (const source of sources) {
    claims.push(...claimsFromDedupeKeys(parseJson(source.dedupe_keys_json || '[]')));
    const url = canonicalUrl(source.source_url);
    if (url) claims.push({ claim: `url:${url}`, kind: 'url' });
    const providerId = providerListingIdentity(source.source_url);
    if (providerId) claims.push({ claim: `pid:${providerId}`, kind: 'pid' });
    if (source.provider && source.source_key) {
      claims.push({ claim: `src:${source.provider}:${source.source_key}`, kind: 'src' });
    }
  }
  return claims;
}

function urlKeys(keys) {
  return (keys || []).filter((key) => String(key).startsWith('url:')).map((key) => String(key).slice(4));
}

function canonicalSourceUrls(values) {
  return new Set(values.map(canonicalUrl).filter(Boolean));
}

function uniqueUrls(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

function parseJson(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : parsed || {};
  } catch {
    return [];
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function markListingGone(listingId, reason, now = Date.now()) {
  if (!listingId) return false;
  const db = SqliteConnection.getConnection();
  const changed = db
    .prepare(`UPDATE listings SET state = 'gone', state_reason = ?, state_at = ? WHERE id = ? AND state = 'active'`)
    .run(String(reason ?? 'no longer advertised').slice(0, 500), now, listingId).changes;
  if (changed) audit(db, { listingId, stage: 'liveness', action: 'gone', reason });
  return changed > 0;
}

export function markListingAlive(listingId, now = Date.now()) {
  if (!listingId) return;
  const db = SqliteConnection.getConnection();
  db.prepare(`UPDATE listings SET last_seen_at = ? WHERE id = ?`).run(now, listingId);
  audit(db, { listingId, stage: 'liveness', action: 'alive' });
}
