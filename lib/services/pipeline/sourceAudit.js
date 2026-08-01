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

/**
 * The source this card should join, if any.
 *
 * Deliberately not scoped to a job. One advert reached by three searches is one
 * advert: scoping the lookup meant each job opened its own work item for it, and
 * with 1,814 URLs seen by more than one job that was the single largest source
 * of duplicated fetches and duplicated LLM calls.
 */
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
  // Excluding by queue id would exclude every sibling rather than just this
  // source: work items are keyed by advert now, so all of an advert's sources
  // share one. The identity of the source is what must be excluded.
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
  // Image hashes are admitted here and nowhere earlier: a content hash shared by
  // two portals is the first evidence in the whole pipeline that can prove one
  // advert was cross-posted, and it does not exist until the images have been
  // downloaded. `vetoes` still has the last word on a single shared image.
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
           CASE WHEN EXISTS (
             SELECT 1 FROM listing_verdicts v WHERE v.listing_id = l.id AND v.verdict = 'accepted'
           ) THEN 0 ELSE 1 END,
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

/**
 * Record that this advert was refused before anything was extracted from it.
 *
 * It does not become a listing. There are no canonical facts behind a card that
 * was never fetched, or a page that was never given to the model — writing one
 * anyway is how the ledger came to hold 10,728 rows of which 260 had ever passed
 * a filter, each one carrying the full captured text of an advert nobody wanted.
 *
 * What it does need is to be recognisable. A refusal nobody can identify is a
 * refusal that gets re-derived on the next capture whose page text differs at
 * all, and that is precisely what the identity claims recorded here prevent.
 *
 * @param {object} detail detail work item in row shape
 * @param {object} params
 * @param {string} params.reason vocabulary reason code
 * @param {'discovery'|'detail'} params.stage
 * @param {'card'|'geo'} params.tier which evidence decided it
 * @param {string} params.configHash job configuration the verdict was reached under
 * @param {string|null} params.evidenceHash evidence the verdict was reached from
 * @param {object} [params.facts] card facts worth keeping for the next comparison
 * @param {string|null} [params.captureHash]
 * @param {object[]} [params.reasons] full reason list, for the audit trail
 * @returns {string|null} the source id the rejection was recorded against
 */
export function recordSourceRejection(
  detail,
  {
    reason,
    stage,
    tier,
    configHash,
    evidenceHash = null,
    facts = {},
    captureHash = null,
    reasons = [],
    queue = 'detail',
  },
) {
  const db = SqliteConnection.getConnection();
  const now = Date.now();
  // A refusal can be reached from either queue: the detail stage refuses before
  // extraction, and the parse stage refuses an advert the model cannot read.
  const column = queue === 'parse' ? 'parsing_queue_id' : 'detail_queue_id';
  return db.transaction(() => {
    const sources = db.prepare(`SELECT * FROM listing_sources WHERE ${column} = ?`).all(detail.id);
    if (!sources.length) return null;
    const upsert = db.prepare(
      `INSERT INTO source_rejections
         (source_id, reason, stage, tier, config_hash, evidence_hash, origin, capture_hash,
          title, address, price, size, rooms, decided_at, decided_count, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         reason = excluded.reason, stage = excluded.stage, tier = excluded.tier,
         config_hash = excluded.config_hash, evidence_hash = excluded.evidence_hash,
         origin = 'live', capture_hash = COALESCE(excluded.capture_hash, capture_hash),
         title = excluded.title, address = excluded.address, price = excluded.price,
         size = excluded.size, rooms = excluded.rooms,
         decided_count = decided_count + 1, last_seen_at = excluded.last_seen_at`,
    );
    for (const source of sources) {
      upsert.run(
        source.id,
        reason,
        stage,
        tier,
        configHash,
        evidenceHash,
        captureHash,
        facts.title ?? null,
        facts.address ?? null,
        finiteOrNull(facts.price),
        finiteOrNull(facts.size),
        finiteOrNull(facts.rooms),
        now,
        now,
      );
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
        payload: { reasons, tier },
      });
      // The claims are the whole point. Nothing wrote them for this path until
      // the day it was noticed that every pre-extraction rejection was invisible
      // to dedupe and came back as a fresh row on the next capture.
      recordSourceClaims(db, source.id, identityClaims([source]), now);
    }
    cancelWork(queue, detail.id, reason);
    return sources[0].id;
  })();
}

/** Terminal filtering is global: preserve rows, but remove all active work. */
export function cancelAllWorkForListing(listingId, reason = 'Listing filtered') {
  if (!listingId) return;
  const db = SqliteConnection.getConnection();
  db.transaction(() => cancelListingWork(db, listingId, reason, Date.now()))();
}

/**
 * Point every source of this capture at the listing it resolved to.
 *
 * The verdict is no longer copied onto the source: there is one verdict per job
 * now, and a source belongs to exactly one job, so denormalising it here would
 * mean three sources of one advert each holding a different answer with nothing
 * to say which was current. `listing_verdicts` is the answer; this is the link.
 *
 * @param {string} parsingQueueId
 * @param {string} listingId
 * @param {string|null} [reason] the verdict reached, for the audit trail only
 * @param {string|null} [dedupeStage]
 * @returns {void}
 */
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

/**
 * Every job that has this advert in flight, oldest first.
 *
 * Work items are keyed by advert now, not by (job, advert), so the job is no
 * longer something the work row can carry — several of them may be waiting on
 * one fetch. The sources are the record of who asked, which is also the only
 * place that stays correct when a fourth job starts halfway through.
 *
 * @param {string} detailQueueId
 * @returns {object[]} job rows
 */
export function jobsForDetailQueue(detailQueueId) {
  return jobsFor('detail_queue_id', detailQueueId);
}

/**
 * @param {string} parsingQueueId
 * @returns {object[]} job rows
 */
export function jobsForParsingQueue(parsingQueueId) {
  return jobsFor('parsing_queue_id', parsingQueueId);
}

function jobsFor(column, queueId) {
  const rows = SqliteConnection.getConnection()
    .prepare(`SELECT DISTINCT job_id FROM listing_sources WHERE ${column} = ? ORDER BY job_id`)
    .all(queueId);
  return rows.map((row) => getJob(row.job_id)).filter(Boolean);
}

/**
 * The identity claims of the advert this parse item is about.
 *
 * @param {string} parsingQueueId
 * @returns {{claim: string, kind: string}[]}
 */
export function identityClaimsForParsingQueue(parsingQueueId) {
  const sources = SqliteConnection.getConnection()
    .prepare('SELECT * FROM listing_sources WHERE parsing_queue_id = ?')
    .all(parsingQueueId);
  return identityClaims(sources);
}

/**
 * An extraction already bought for the same advert, if there is one.
 *
 * Two captures of one advert differ in page text — a sidebar, a re-rendered
 * timestamp — which is enough to make a second parse item with a second key. The
 * facts behind them are the same, so the second call is pure waste. Reuse is
 * restricted to identity claims: a resemblance match is a guess, and copying an
 * extraction onto the wrong flat would be a far worse error than a repeated call.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} parsingQueueId the item asking
 * @param {{claim: string, kind: string}[]} claims its identity claims
 * @returns {{queue_id: string, llm_json: object, text_model: string|null}|null}
 */
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

/**
 * The provider says this advert is gone.
 *
 * That used to be recorded as an audit line and nowhere else: `is_active` had no
 * code path that ever set it to 0 and `inactive_reason` was only ever written
 * NULL, so a let flat stayed indistinguishable from an available one for every
 * consumer — including the market corpus, which trains on prices that are no
 * longer offers. `state` is the one axis that replaced those columns, and this is
 * what writes to it.
 *
 * @param {string} detailQueueId
 * @param {string} reason
 * @returns {void}
 */
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
    // Only when every source agrees it is gone. One portal delisting a flat that
    // another still advertises is a delisting on that portal, not a let flat.
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
