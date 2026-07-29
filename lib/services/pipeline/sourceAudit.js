/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import SqliteConnection from '../storage/SqliteConnection.js';
import { saveListingText } from '../storage/listingTextStorage.js';
import {
  canonicalUrl,
  claimsFromDedupeKeys,
  compareSurvivors,
  providerListingIdentity,
  resolveClaims,
} from '../listings/claims.js';
import { cancelWork, cancelWorkForListing, getWork, patchWorkPayload } from './workQueue.js';

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

export function findDiscoveryRepresentative(db, { jobId, provider, sourceKey, sourceUrl, dedupeKeys }) {
  if (!dedupeKeys.length && !sourceUrl) return null;
  const matchedKey = db
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
  if (matchedKey) return matchedKey;

  const canonicalUrls = canonicalSourceUrls([sourceUrl, ...urlKeys(dedupeKeys)]);
  if (!canonicalUrls.size) return null;
  return db
    .prepare(
      `SELECT s.*
       FROM listing_sources s
       WHERE s.job_id = ? AND s.provider = ? AND s.source_key != ?
         AND s.detail_queue_id IS NOT NULL
       ORDER BY s.first_seen_at ASC`,
    )
    .all(jobId, provider, sourceKey)
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
         SET dedupe_keys_json = ?, last_seen_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(dedupeKeys), now, source.id);
      recordObservation(db, source.id, 'detail', contentHash, capture, now);
      audit(db, { sourceId: source.id, queueId: detail.id, stage: 'detail', action: 'captured' });
    }
  })();
}

/**
 * The source this capture should be merged into, if any.
 *
 * Two lookups, in this order, because they answer two different questions:
 *
 *   in flight — another source in the same job already holds one of these dedupe
 *     keys and is on its way through the pipeline. Nothing is stored yet, so
 *     `listing_sources.dedupe_keys_json` is the only record there is. This is the
 *     json_each intersection the claim table was modelled on, and the composite
 *     `card-image:`/`evidence-image:` keys belong here: at this stage there is no
 *     listing to veto an image match against, so the key carries its own
 *     evidence fingerprint instead.
 *
 *   already stored — a listing owns one of this capture's identity claims. This
 *     replaces the O(n) canonical-URL scan that used to run over every source in
 *     the job, which existed only because rows predating dedupe_keys_json had no
 *     other way to be found. The backfill gives them claims, so they do now.
 *
 * @param {object} detail detail_fetch_queue row
 * @param {string[]} dedupeKeys
 * @returns {object|null} listing_sources row
 */
export function findDetailRepresentative(detail, dedupeKeys) {
  if (!dedupeKeys.length) return null;
  const db = SqliteConnection.getConnection();
  const matchedKey = db
    .prepare(
      `SELECT s.*
       FROM listing_sources s, json_each(s.dedupe_keys_json) known
       WHERE s.job_id = ?
         AND s.detail_queue_id != ?
         AND known.value IN (SELECT value FROM json_each(?))
         AND (s.representative_source_id IS NULL OR s.representative_source_id = s.id)
         AND (s.parsing_queue_id IS NOT NULL OR s.listing_id IS NOT NULL OR s.hidden_reason IS NOT NULL)
       ORDER BY s.first_seen_at ASC
       LIMIT 1`,
    )
    .get(detail.job_id, detail.id, JSON.stringify(dedupeKeys));
  if (matchedKey) return matchedKey;
  return storedClaimRepresentative(db, detail, dedupeKeys);
}

/**
 * A source belonging to a listing that already owns one of this capture's
 * identity claims. Only identity kinds are consulted: a resemblance claim needs
 * the post-LLM facts to be vetoed against, and this stage has none of them.
 *
 * Deliberately not scoped to the job. One provider offer reached by two searches
 * is one ad, and resolving it here rather than after the LLM has run is what
 * saves the call.
 */
function storedClaimRepresentative(db, detail, dedupeKeys) {
  const claims = claimsFromDedupeKeys(dedupeKeys).filter(({ kind }) => kind === 'url' || kind === 'pid');
  const listingIds = [...new Set(resolveClaims(db, claims).map((match) => match.listing_id))];
  if (!listingIds.length) return null;
  return (
    db
      .prepare(
        `SELECT s.*
         FROM listing_sources s
         JOIN listings l ON l.id = s.listing_id
         WHERE s.listing_id IN (SELECT value FROM json_each(?))
           AND (s.detail_queue_id IS NULL OR s.detail_queue_id != ?)
           AND (s.representative_source_id IS NULL OR s.representative_source_id = s.id)
         ORDER BY
           CASE WHEN l.manually_deleted = 0 AND l.hidden_reason IS NULL THEN 0 ELSE 1 END,
           s.first_seen_at ASC
         LIMIT 1`,
      )
      .get(JSON.stringify(listingIds), detail.id) || null
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
             parsing_queue_id = ?, listing_id = ?,
             hidden_reason = ?, last_seen_at = ?
         WHERE id = ?`,
      ).run(
        representative.id,
        representative.parsing_queue_id,
        representative.listing_id,
        representative.hidden_reason,
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
    hiddenReason: representative.hidden_reason,
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

export function markPreLlmHidden(detail, sourceHash, capture, reason, reasons = [{ code: reason, stage: 'pre_llm' }]) {
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
    listing ??= db
      .prepare(
        `SELECT l.* FROM listing_sources s JOIN listings l ON l.id = s.listing_id
         WHERE s.detail_queue_id = ? ORDER BY l.created_at ASC LIMIT 1`,
      )
      .get(detail.id);
    listing ??= findOwnerExactSourceListing(db, sources);
    const preserveVisibleOwnerListing =
      listing && listing.job_id !== detail.job_id && !listing.manually_deleted && !listing.hidden_reason;
    if (!listing) {
      const listingId = nanoid();
      db.prepare(
        `INSERT INTO listings (
           id, hash, provider, job_id, price, size, rooms, title, image_url,
           address, link, created_at, is_active, manually_deleted,
           hidden_reason, source_urls_json, filter_reasons_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
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
        discovery.address ?? null,
        primary?.source_url || detail.source_url,
        detail.discovery.discoveredAt ?? detail.created_at ?? now,
        reason,
        JSON.stringify(urls),
        JSON.stringify(reasons),
      );
      saveListingText(
        listingId,
        capture.fullText || [discovery.title, discovery.description, discovery.address].filter(Boolean).join('\n'),
        now,
        db,
      );
      listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
    } else if (!preserveVisibleOwnerListing) {
      db.prepare(
        `UPDATE listings
         SET manually_deleted = 1, hidden_reason = COALESCE(hidden_reason, ?), filter_reasons_json = ?
         WHERE id = ?`,
      ).run(reason, JSON.stringify(reasons), listing.id);
    }
    saveListingText(
      listing.id,
      capture.fullText || [discovery.title, discovery.description, discovery.address].filter(Boolean).join('\n'),
      now,
      db,
    );
    for (const source of sources) {
      db.prepare(
        `UPDATE listing_sources
         SET listing_id = ?, hidden_reason = ?, dedupe_stage = COALESCE(dedupe_stage, 'pre_llm'),
             last_seen_at = ? WHERE id = ?`,
      ).run(listing.id, reason, now, source.id);
      audit(db, {
        sourceId: source.id,
        listingId: listing.id,
        queueId: detail.id,
        stage: 'pre_llm_filter',
        action: preserveVisibleOwnerListing ? 'source_filtered' : 'soft_deleted',
        reason,
        payload: { reasons, canonicalListingPreserved: preserveVisibleOwnerListing },
      });
    }
    refreshListingLinks(db, listing.id);
    if (!preserveVisibleOwnerListing) cancelListingWork(db, listing.id, reason, now);
    // The detail item is a work row keyed by source identity now, and dropping
    // the bulk payload on a terminal transition is the queue's own behaviour
    // rather than something every caller open-codes.
    cancelWork('detail', detail.id, reason);
    return listing.id;
  })();
}

/** Terminal filtering is global: preserve rows, but remove all active work. */
export function cancelAllWorkForListing(listingId, reason = 'Listing filtered') {
  if (!listingId) return;
  const db = SqliteConnection.getConnection();
  db.transaction(() => cancelListingWork(db, listingId, reason, Date.now()))();
}

export function attachSourcesToListing(parsingQueueId, listingId, hiddenReason = null, dedupeStage = null) {
  if (!parsingQueueId || !listingId) return;
  const db = SqliteConnection.getConnection();
  const now = Date.now();
  db.transaction(() => {
    const sources = db.prepare('SELECT * FROM listing_sources WHERE parsing_queue_id = ?').all(parsingQueueId);
    for (const source of sources) {
      db.prepare(
        `UPDATE listing_sources
         SET listing_id = ?, hidden_reason = ?,
             dedupe_stage = COALESCE(?, dedupe_stage), last_seen_at = ?
         WHERE id = ?`,
      ).run(listingId, hiddenReason, dedupeStage, now, source.id);
      audit(db, {
        sourceId: source.id,
        listingId,
        queueId: parsingQueueId,
        stage: dedupeStage === 'final' ? 'final_dedupe' : 'post_llm_filter',
        action: dedupeStage === 'final' ? 'merged' : hiddenReason ? 'soft_deleted' : 'accepted',
        reason: hiddenReason,
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

/**
 * Every URL that resolved to this parse item has to reach the notification, so
 * the captured evidence carries the union of them. The capture now lives in the
 * work payload rather than a queue column, so this patches the payload instead
 * of rewriting a row.
 */
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

/**
 * Terminal filtering is global: the rows stay, but every outstanding unit of
 * work for this listing stops.
 *
 * This used to cancel four tables by hand, resolving detail and parse ids
 * through listing_sources itself. There is one work table now, and the queue
 * already knows how to find a listing's items, so this is a delegation rather
 * than four near-identical UPDATE statements that could drift apart.
 */
function cancelListingWork(db, listingId, reason) {
  void db;
  cancelWorkForListing(listingId, reason);
}

/**
 * The stored listing these sources already belong to, by identity claim.
 *
 * Was two queries: a json_each intersection over `dedupe_keys_json` and, for rows
 * written before that column existed, a scan of every source the owner has ever
 * collected. The claim table answers both — the migration derives claims from
 * whatever a legacy row does have — and it is one indexed lookup instead of a
 * join across jobs plus an O(n) find() in JS.
 *
 * Identity kinds only. A resemblance match here would attach a source to a row
 * chosen on inference, which is a decision for the finalizer, where the post-LLM
 * facts exist to veto it.
 */
function findOwnerExactSourceListing(db, sources) {
  const matches = resolveClaims(db, identityClaims(sources)).filter(({ kind }) => kind !== 'img');
  const listingIds = [...new Set(matches.map((match) => match.listing_id))];
  if (!listingIds.length) return null;
  const rows = db
    .prepare('SELECT * FROM listings WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(listingIds));
  return rows.sort(compareSurvivors)[0] || null;
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
