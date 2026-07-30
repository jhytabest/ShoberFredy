/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { nanoid } from 'nanoid';
import SqliteConnection from '../storage/SqliteConnection.js';
import { saveListingText } from '../storage/listingTextStorage.js';
import { getJob } from '../storage/jobStorage.js';
import { sha256 } from '../../shared/hash.js';
import { fromJson, jsonObject, toJson } from '../../shared/json.js';
import { auditWork, cancelWork, completeWork, enqueueWork, getWork, patchWorkPayload } from './workQueue.js';
import {
  attachParsingQueue,
  findDiscoveryRepresentative,
  markDiscoveryDuplicate,
  markPreLlmHidden,
  recordDiscoverySource,
} from './sourceAudit.js';
import { canonicalUrl, discoveryDedupeKeys } from '../listings/claims.js';
import { preLlmFilterReasons, primaryFilterReason } from './listingFilters.js';

/**
 * The evidence side of the pipeline: what a detail item and a parse item mean.
 *
 * All queue mechanics — claiming, leasing, retrying, backing off — live in
 * workQueue.js. What is left here is the part that is genuinely about listings:
 * how a source is identified, when a capture counts as new, and what has to
 * happen to the images, the extraction and the listing text when a parse
 * finishes.
 */

/**
 * A detail item is one provider advert seen by one job. Price is deliberately
 * not part of the key: repricing produces a new evidence version of the same
 * offer, not a second source identity.
 */
export function detailKey(jobId, provider, sourceKey) {
  return `${jobId}|${provider}|${sourceKey}`;
}

/**
 * A parse item is one *version* of the captured evidence, so unchanged evidence
 * cannot be parsed twice and changed evidence gets its own images and its own
 * extraction rather than overwriting the previous answer. Job-scoped because the
 * hash is job-independent and two jobs finalize into their own listings.
 */
export function parseKey(jobId, sourceHash) {
  return `${jobId}|${sourceHash}`;
}

/** Expose a detail work item under the field names the audit layer reads. */
export function toDetailRow(item) {
  if (!item) return null;
  const payload = item.payload ?? {};
  return {
    ...item,
    id: item.key,
    job_id: payload.jobId,
    provider: payload.provider,
    source_key: payload.sourceKey,
    external_id: payload.externalId ?? null,
    source_url: payload.sourceUrl,
    discovery_hash: payload.discoveryHash,
    discovery: payload.discovery ?? {},
    capture_queue_id: payload.captureKey ?? null,
  };
}

/** Expose a parse work item under the field names the finalizer reads. */
export function toParseRow(item) {
  if (!item) return null;
  const payload = item.payload ?? {};
  return {
    ...item,
    id: item.key,
    job_id: payload.jobId,
    provider: payload.provider,
    source_key: payload.sourceKey,
    source_hash: payload.sourceHash,
    listing_id: payload.listingId ?? null,
    external_id: payload.externalId ?? null,
    source_url: payload.sourceUrl ?? null,
    discovered_at: payload.discoveredAt,
    stage: payload.stage ?? 'captured',
    llm_attempt_count: Number(payload.llmAttempts || 0),
    geocode_attempt_count: Number(payload.geocodeAttempts || 0),
    capture: payload.capture ?? {},
  };
}

/**
 * Store one discovery card as durable pre-LLM evidence.
 *
 * The card, its dedupe decision and the work item are written in one
 * transaction, so a crash cannot leave a source recorded without the work that
 * was supposed to act on it.
 *
 * @param {{jobId: string, provider: string, listing: object}} params
 * @returns {{id: string, changed: boolean, deduped?: boolean, filtered?: boolean}}
 */
export function enqueueDiscovery({ jobId, provider, listing }) {
  const db = SqliteConnection.getConnection();
  const sourceUrl = canonicalUrl(listing.link);
  const sourceKey = String(listing.externalId || sourceUrl);
  const key = detailKey(jobId, provider, sourceKey);
  // Discovery timestamps are observations, not content. Excluding them stops
  // every scheduled run from requeueing an otherwise unchanged source.
  const discoveryHash = sha256(JSON.stringify({ ...listing, discoveredAt: undefined }));
  const dedupeKeys = discoveryDedupeKeys(listing);

  const identity = { jobId, provider, sourceKey, sourceUrl, listing, discoveryHash, dedupeKeys };

  const result = db.transaction(() => {
    // Discovery dedupe only asks the question once, for a source nobody has seen
    // before: an advert already tied to a work item keeps that tie.
    if (!getWork('detail', key)) {
      const representative = findDiscoveryRepresentative(db, identity);
      if (representative) {
        const source = recordDiscoverySource(db, { ...identity, detailQueueId: representative.detail_queue_id });
        markDiscoveryDuplicate(db, source.id, representative);
        return { id: representative.detail_queue_id, changed: true, deduped: true };
      }
    }

    const enqueued = enqueueWork(
      'detail',
      key,
      {
        jobId,
        provider,
        sourceKey,
        externalId: listing.externalId ?? null,
        sourceUrl,
        discoveryHash,
        discovery: listing,
      },
      { mode: 'fingerprint', fingerprintKey: 'discoveryHash' },
    );
    recordDiscoverySource(db, { ...identity, detailQueueId: key });
    return { id: key, changed: enqueued.changed };
  })();

  // The source and its discovery dedupe decision are already durable. If the
  // card itself proves a terminal filter, do not spend a detail request while
  // it waits behind a blocked provider.
  const reasons = preLlmFilterReasons(listing, getJob(jobId));
  if (reasons.length && result?.id) {
    const detail = toDetailRow(getWork('detail', result.id));
    if (detail) {
      const reason = primaryFilterReason(reasons);
      // Search results keep showing the same ads for weeks, so a card we have
      // already rejected comes back on every run of every job. Re-recording an
      // unchanged verdict costs a full transaction over the listing, all of its
      // sources and the audit log: one wg-gesucht URL was re-decided 401 times
      // in seven days, and the three jobs together produced ~13,000 soft-delete
      // events a day against ~860 genuinely new cards. The stored decision is
      // the answer; only re-derive it when it could have changed.
      if (alreadyDecided(detail, reason)) return { ...result, filtered: true };
      const sourceHash = sha256(JSON.stringify({ provider, sourceKey, discoveryHash, filtered: true }));
      markPreLlmHidden(detail, sourceHash, { fullText: '', images: [] }, reason, reasons);
      return { ...result, filtered: true };
    }
  }
  return result;
}

/**
 * Whether this exact pre-LLM verdict is already recorded against the work item.
 *
 * Matching on the reason and not merely on "is terminal" keeps the filter
 * responsive to configuration: widen the blacklist and the new reason differs
 * from the stored one, so the listing is re-decided on its next discovery.
 *
 * @param {object} detail detail work item in row shape
 * @param {string} reason primary filter reason for the current card
 * @returns {boolean}
 */
function alreadyDecided(detail, reason) {
  return detail.status === 'cancelled' && detail.last_error === reason;
}

/** The identity of one captured version of one source. */
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

/**
 * Hand a completed capture to the parser.
 *
 * @param {object} params
 * @returns {string} the parse work key
 */
export function enqueueCapture({ jobId, provider, sourceHash, capture, images = [], listingId, detailQueueId }) {
  const db = SqliteConnection.getConnection();
  const key = parseKey(jobId, sourceHash);
  const sourceKey = String(capture.externalId || canonicalUrl(capture.sourceUrl) || sourceHash);

  db.transaction(() => {
    supersedeOlderCaptures(db, key, jobId, provider, sourceKey);
    // The key already contains the hash, so an unchanged capture re-enqueued
    // after a restart resolves to the same row and changes nothing.
    enqueueWork(
      'parse',
      key,
      {
        jobId,
        provider,
        sourceKey,
        sourceHash,
        listingId: listingId ?? null,
        externalId: capture.externalId ?? null,
        sourceUrl: capture.sourceUrl ?? null,
        discoveredAt: capture.discoveredAt ?? Date.now(),
        stage: 'captured',
        capture,
      },
      { mode: 'fingerprint', fingerprintKey: 'sourceHash' },
    );
    replaceQueueImages(db, key, listingId, images);
  })();

  if (detailQueueId) attachParsingQueue(detailQueueId, key);
  return key;
}

/**
 * There is only one unfinished semantic parse per stable provider advert.
 *
 * Content-addressed keys alone would not guarantee that: a re-capture with
 * changed page text is a new key, and without this the pipeline would hold two
 * claimable parse items for the same advert and spend two LLM calls answering
 * the same question. The superseded item keeps its images and its extraction —
 * nothing is deleted, it simply stops being work.
 */
function supersedeOlderCaptures(db, key, jobId, provider, sourceKey) {
  const stale = db
    .prepare(
      `SELECT key FROM pipeline_work
       WHERE kind = 'parse' AND key != @key
         AND status IN ('pending', 'retry', 'processing')
         AND json_extract(payload_json, '$.jobId') = @jobId
         AND json_extract(payload_json, '$.provider') = @provider
         AND json_extract(payload_json, '$.sourceKey') = @sourceKey`,
    )
    .all({ key, jobId, provider, sourceKey });
  for (const row of stale) {
    cancelWork('parse', row.key, 'Superseded by a newer capture of the same advert', { action: 'superseded' });
  }
}

/**
 * Images belong to the capture version that produced them. Replacing them for
 * this key rather than merging keeps position numbering contiguous, which the
 * UNIQUE(queue_id, position) constraint depends on.
 */
function replaceQueueImages(db, key, listingId, images) {
  if (!images.length) return;
  db.prepare('DELETE FROM listing_images WHERE queue_id = ?').run(key);
  const insert = db.prepare(
    `INSERT INTO listing_images (
       id, queue_id, listing_id, position, kind, original_url, storage_path,
       content_hash, mime_type, byte_size, width, height, download_status, error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const image of images) {
    insert.run(
      nanoid(),
      key,
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
}

export function saveExtraction(key, patch) {
  const db = SqliteConnection.getConnection();
  db.transaction(() => {
    const listingId = jsonObject(
      db.prepare("SELECT payload_json FROM pipeline_work WHERE kind = 'parse' AND key = ?").pluck().get(key),
    ).listingId;
    const current = db.prepare('SELECT * FROM listing_extractions WHERE queue_id = ?').get(key) || {};
    const value = { ...current, ...patch };
    db.prepare(
      `INSERT INTO listing_extractions (
         queue_id, listing_id, llm_json, text_model, llm_duration_ms, parsed_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(queue_id) DO UPDATE SET
         listing_id = excluded.listing_id,
         llm_json = excluded.llm_json,
         text_model = excluded.text_model,
         llm_duration_ms = excluded.llm_duration_ms,
         parsed_at = excluded.parsed_at`,
    ).run(
      key,
      value.listing_id ?? listingId ?? null,
      jsonOrNull(value.llm_json),
      value.text_model ?? null,
      value.llm_duration_ms ?? null,
      value.parsed_at ?? null,
    );
  })();
}

export function getExtraction(key) {
  const row = SqliteConnection.getConnection().prepare('SELECT * FROM listing_extractions WHERE queue_id = ?').get(key);
  if (!row) return null;
  row.llm_json = fromJson(row.llm_json, null);
  return row;
}

/** Record which stage of parsing an item reached, for operator visibility. */
export function updateParseStage(key, stage, auditEvent = null) {
  patchWorkPayload('parse', key, { stage });
  if (auditEvent) {
    auditWork('parse', key, {
      stage,
      action: auditEvent.action,
      reason: auditEvent.reason,
      payload: auditEvent.payload,
    });
  }
}

/**
 * Finish one parse item and attach everything it produced to the listing.
 *
 * A cancelled item is left alone: terminal filtering is global, so a parse that
 * finishes after its listing was hidden must not resurrect it, and its images
 * and extraction must not be reassigned to a listing the user no longer sees.
 *
 * @param {string} key
 * @param {string|null} listingId
 * @param {string} [status]
 */
export function completeParse(key, listingId, status = 'completed') {
  SqliteConnection.withTransaction((db) => {
    const fullText = toParseRow(getWork('parse', key))?.capture?.fullText;
    const finished = completeWork('parse', key, {
      status,
      patch: { listingId: listingId ?? null, stage: 'completed' },
    });
    if (!finished || !listingId) return;
    saveListingText(listingId, fullText, Date.now(), db);
    db.prepare('UPDATE listing_images SET listing_id = ? WHERE queue_id = ?').run(listingId, key);
    db.prepare('UPDATE listing_extractions SET listing_id = ? WHERE queue_id = ?').run(listingId, key);
    db.prepare('UPDATE llm_call_audit SET listing_id = COALESCE(listing_id, ?) WHERE queue_id = ?').run(listingId, key);
  });
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

function jsonOrNull(value) {
  if (value == null) return null;
  return typeof value === 'string' ? value : toJson(value);
}
