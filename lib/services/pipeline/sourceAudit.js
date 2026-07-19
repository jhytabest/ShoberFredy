/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import SqliteConnection from '../storage/SqliteConnection.js';

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
         dedupe_keys_json, discovery_json, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      jobId,
      provider,
      sourceKey,
      sourceUrl,
      detailQueueId,
      JSON.stringify(dedupeKeys),
      JSON.stringify(listing),
      now,
      now,
    );
    source = db.prepare('SELECT * FROM listing_sources WHERE id = ?').get(id);
  } else {
    const storedKeys = parseJson(source.dedupe_keys_json || '[]');
    const mergedKeys = [...new Set([...(Array.isArray(storedKeys) ? storedKeys : []), ...dedupeKeys])];
    db.prepare(
      `UPDATE listing_sources
       SET source_url = ?, detail_queue_id = COALESCE(?, detail_queue_id),
           dedupe_keys_json = ?, discovery_json = ?, last_seen_at = ?
       WHERE id = ?`,
    ).run(sourceUrl, detailQueueId, JSON.stringify(mergedKeys), JSON.stringify(listing), now, source.id);
    source = db.prepare('SELECT * FROM listing_sources WHERE id = ?').get(source.id);
  }
  recordObservation(db, source.id, 'discovery', discoveryHash, listing, now);
  return source;
}

export function findDiscoveryRepresentative(db, { jobId, provider, sourceKey, dedupeKeys }) {
  if (!dedupeKeys.length) return null;
  return db
    .prepare(
      `SELECT s.*
       FROM listing_sources s, json_each(s.dedupe_keys_json) known
       WHERE s.job_id = ?
         AND NOT (s.provider = ? AND s.source_key = ?)
         AND known.value IN (SELECT value FROM json_each(?))
         AND s.detail_queue_id IS NOT NULL
       ORDER BY s.first_seen_at ASC
       LIMIT 1`,
    )
    .get(jobId, provider, sourceKey, JSON.stringify(dedupeKeys));
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
  if (representative.listing_id) refreshListingLinks(db, representative.listing_id);
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
         SET capture_json = ?, dedupe_keys_json = ?, last_seen_at = ?
         WHERE id = ?`,
      ).run(payload, JSON.stringify(dedupeKeys), now, source.id);
      recordObservation(db, source.id, 'detail', contentHash, capture, now);
      audit(db, { sourceId: source.id, queueId: detail.id, stage: 'detail', action: 'captured' });
    }
  })();
}

export function findDetailRepresentative(detail, dedupeKeys) {
  if (!dedupeKeys.length) return null;
  const db = SqliteConnection.getConnection();
  return db
    .prepare(
      `SELECT s.*
       FROM listing_sources s, json_each(s.dedupe_keys_json) known
       WHERE s.job_id = ?
         AND s.detail_queue_id != ?
         AND s.capture_json IS NOT NULL
         AND known.value IN (SELECT value FROM json_each(?))
         AND (s.representative_source_id IS NULL OR s.representative_source_id = s.id)
         AND (s.parsing_queue_id IS NOT NULL OR s.listing_id IS NOT NULL OR s.pre_llm_hidden_reason IS NOT NULL)
       ORDER BY s.first_seen_at ASC
       LIMIT 1`,
    )
    .get(detail.job_id, detail.id, JSON.stringify(dedupeKeys));
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
             parsing_queue_id = ?, listing_id = ?,
             pre_llm_hidden_reason = ?, post_llm_hidden_reason = ?, last_seen_at = ?
         WHERE id = ?`,
      ).run(
        representative.id,
        representative.parsing_queue_id,
        representative.listing_id,
        representative.pre_llm_hidden_reason,
        representative.post_llm_hidden_reason,
        now,
        source.id,
      );
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
    if (representative.listing_id) refreshListingLinks(db, representative.listing_id);
  })();
  return {
    parsingQueueId: representative.parsing_queue_id,
    listingId: representative.listing_id,
    hiddenReason: representative.pre_llm_hidden_reason,
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

export function markPreLlmHidden(detail, sourceHash, capture, reason) {
  const db = SqliteConnection.getConnection();
  const now = Date.now();
  return db.transaction(() => {
    const sources = db.prepare('SELECT * FROM listing_sources WHERE detail_queue_id = ?').all(detail.id);
    const urls = uniqueUrls(sources.map((source) => source.source_url));
    const primary = sources.find(
      (source) => source.provider === detail.provider && source.source_key === detail.source_key,
    );
    const discovery = detail.discovery || {};
    let listing = db.prepare('SELECT * FROM listings WHERE job_id = ? AND hash = ?').get(detail.job_id, sourceHash);
    if (!listing) {
      const listingId = nanoid();
      db.prepare(
        `INSERT INTO listings (
           id, hash, provider, job_id, price, size, rooms, title, image_url,
           description, address, link, created_at, is_active, manually_deleted,
           hidden_reason, canonical_schema_version, source_urls_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 0, ?)`,
      ).run(
        listingId,
        sourceHash,
        detail.provider,
        detail.job_id,
        finiteOrNull(discovery.price),
        finiteOrNull(discovery.size),
        finiteOrNull(discovery.rooms),
        discovery.title ?? '',
        discovery.image ?? capture.images?.[0]?.originalUrl ?? null,
        capture.fullText || '',
        discovery.address ?? null,
        primary?.source_url || detail.source_url,
        detail.discovery.discoveredAt ?? detail.created_at ?? now,
        reason,
        JSON.stringify(urls),
      );
      listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
    }
    for (const source of sources) {
      db.prepare(
        `UPDATE listing_sources
         SET listing_id = ?, pre_llm_hidden_reason = ?, dedupe_stage = COALESCE(dedupe_stage, 'pre_llm'),
             last_seen_at = ? WHERE id = ?`,
      ).run(listing.id, reason, now, source.id);
      audit(db, {
        sourceId: source.id,
        listingId: listing.id,
        queueId: detail.id,
        stage: 'pre_llm_blacklist',
        action: 'soft_deleted',
        reason,
      });
    }
    refreshListingLinks(db, listing.id);
    return listing.id;
  })();
}

export function attachSourcesToListing(parsingQueueId, listingId, postLlmHiddenReason = null, dedupeStage = null) {
  if (!parsingQueueId || !listingId) return;
  const db = SqliteConnection.getConnection();
  const now = Date.now();
  db.transaction(() => {
    const sources = db.prepare('SELECT * FROM listing_sources WHERE parsing_queue_id = ?').all(parsingQueueId);
    for (const source of sources) {
      db.prepare(
        `UPDATE listing_sources
         SET listing_id = ?, post_llm_hidden_reason = ?,
             dedupe_stage = COALESCE(?, dedupe_stage), last_seen_at = ?
         WHERE id = ?`,
      ).run(listingId, postLlmHiddenReason, dedupeStage, now, source.id);
      audit(db, {
        sourceId: source.id,
        listingId,
        queueId: parsingQueueId,
        stage: dedupeStage === 'final' ? 'final_dedupe' : 'post_llm_filter',
        action: dedupeStage === 'final' ? 'merged' : postLlmHiddenReason ? 'soft_deleted' : 'accepted',
        reason: postLlmHiddenReason,
      });
    }
    refreshListingLinks(db, listingId);
  })();
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
  db.transaction(() => {
    const sources = db.prepare('SELECT id FROM listing_sources WHERE detail_queue_id = ?').all(detailQueueId);
    for (const source of sources) {
      audit(db, {
        sourceId: source.id,
        queueId: detailQueueId,
        stage: 'detail',
        action: 'inactive',
        reason,
      });
    }
  })();
}

function mergeLinksIntoParsingQueue(db, parsingQueueId) {
  const row = db.prepare('SELECT capture_json FROM parsing_queue WHERE id = ?').get(parsingQueueId);
  if (!row) return;
  const capture = parseJson(row.capture_json) || {};
  const sources = db
    .prepare('SELECT source_url FROM listing_sources WHERE parsing_queue_id = ? ORDER BY first_seen_at')
    .all(parsingQueueId);
  capture.sourceLinks = uniqueUrls([...(capture.sourceLinks || []), ...sources.map((source) => source.source_url)]);
  db.prepare('UPDATE parsing_queue SET capture_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(capture),
    Date.now(),
    parsingQueueId,
  );
}

function refreshListingLinks(db, listingId) {
  const listing = db.prepare('SELECT link, source_urls_json FROM listings WHERE id = ?').get(listingId);
  if (!listing) return;
  const sources = db
    .prepare('SELECT source_url FROM listing_sources WHERE listing_id = ? ORDER BY first_seen_at')
    .all(listingId);
  const storedUrls = parseJson(listing.source_urls_json || '[]');
  const urls = uniqueUrls([
    listing.link,
    ...(Array.isArray(storedUrls) ? storedUrls : []),
    ...sources.map((source) => source.source_url),
  ]);
  db.prepare('UPDATE listings SET source_urls_json = ? WHERE id = ?').run(JSON.stringify(urls), listingId);
}

function recordObservation(db, sourceId, stage, contentHash, payload, observedAt) {
  db.prepare(
    `INSERT OR IGNORE INTO listing_source_observations (
       id, source_id, stage, content_hash, payload_json, observed_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(nanoid(), sourceId, stage, contentHash, JSON.stringify(payload), observedAt);
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

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
