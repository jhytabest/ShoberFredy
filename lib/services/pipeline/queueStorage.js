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
import { env } from '../../shared/env.js';
import {
  CLAIMABLE_SQL,
  cancelWork,
  completeWork,
  enqueueWork,
  getWork,
  patchWorkPayload,
} from './workQueue.js';
import { attachParsingQueue, recordDiscoverySource } from './sourceAudit.js';
import { canonicalUrl, sourceKeyFor } from '../listings/claims.js';
import { buildEvidence, PROMPT_VERSION } from './listingLlmParser.js';
import { EXTRACTION_VERSION } from './listingSchema.js';

export const extractionVersion = () => `${EXTRACTION_VERSION}:${PROMPT_VERSION}`;

export function detailKey(provider, sourceKey) {
  return `${provider}|${sourceKey}`;
}

export function parseKey(sourceHash) {
  return sourceHash;
}

export function toDetailRow(item) {
  if (!item) return null;
  const payload = item.payload ?? {};
  return {
    ...item,
    id: item.key,
    provider: payload.provider,
    market: payload.market ?? null,
    city: payload.city ?? null,
    source_key: payload.sourceKey,
    external_id: payload.externalId ?? null,
    source_url: payload.sourceUrl,
    discovery_hash: payload.discoveryHash,
    discovery: payload.discovery ?? {},
    capture_queue_id: payload.captureKey ?? null,
  };
}

export function toParseRow(item) {
  if (!item) return null;
  const payload = item.payload ?? {};
  return {
    ...item,
    id: item.key,
    provider: payload.provider,
    source_key: payload.sourceKey,
    source_hash: payload.sourceHash,
    listing_id: payload.listingId ?? null,
    external_id: payload.externalId ?? null,
    source_url: payload.sourceUrl ?? null,
    discovered_at: payload.discoveredAt,
    stage: payload.stage ?? 'captured',
    llm_attempt_count: Number(payload.llmAttempts || 0),
    capture: payload.capture ?? {},
  };
}

export function enqueueDiscovery({ jobId, provider, listing }) {
  const db = SqliteConnection.getConnection();
  const job = getJob(jobId);
  const sourceUrl = canonicalUrl(listing.link);
  const sourceKey = sourceKeyFor(provider, listing.externalId, sourceUrl);
  const key = detailKey(provider, sourceKey);
  const discovery = { ...listing, link: sourceUrl };
  // Links, images, portal IDs and relative card prose are not property changes.
  const discoveryHash = sha256(JSON.stringify([provider, sourceKey, listing.title, listing.price, listing.size, listing.rooms, listing.address]));
  return db.transaction(() => {
    const source = recordDiscoverySource(db, { jobId, city: job?.city ?? null, provider, sourceKey, sourceUrl, listing: discovery, discoveryHash, detailQueueId: key });
    if (source.historical) return { id: key, changed: false, historical: true };
    const version = extractionVersion();
    const fingerprint = `${discoveryHash}:${version}`;
    const enqueued = enqueueWork('detail', key, {
      provider, market: job?.market ?? null, city: source.city ?? job?.city ?? null,
      sourceKey, externalId: listing.externalId ?? null, sourceUrl,
      discoveryHash: fingerprint, discovery,
    }, { mode: 'fingerprint', fingerprintKey: 'discoveryHash' });
    db.prepare('UPDATE listing_sources SET discovery_hash=?,extraction_version=? WHERE id=?').run(discoveryHash, version, source.id);
    return { id: key, changed: enqueued.changed };
  })();
}

export function captureVersionHash(provider, sourceKey, capture) {
  return sha256(JSON.stringify([provider, sourceKey, extractionVersion(), buildEvidence(capture)]));
}

export function enqueueCapture({
  provider,
  sourceHash,
  capture,
  images = [],
  listingId,
  detailQueueId,
}) {
  const db = SqliteConnection.getConnection();
  const key = parseKey(sourceHash);
  const sourceKey = sourceKeyFor(provider, capture.externalId, capture.sourceUrl) || sourceHash;

  db.transaction(() => {
    supersedeOlderCaptures(db, key, provider, sourceKey);
    enqueueWork(
      'parse',
      key,
      {
        provider,
        sourceKey,
        sourceHash,
        listingId: listingId ?? null,
        externalId: capture.externalId ?? null,
        sourceUrl: capture.sourceUrl ?? null,
        discoveredAt: capture.discoveredAt ?? Date.now(),
        stage: 'captured',
        city: capture.city ?? null,
        capture,
      },
      { mode: 'ignore' },
    );
    if (!db.prepare('SELECT 1 FROM listing_images WHERE queue_id=? LIMIT 1').get(key)) replaceQueueImages(db, key, listingId, images);
    if (detailQueueId) attachParsingQueue(detailQueueId, key, db);
  })();
  return key;
}

function supersedeOlderCaptures(db, key, provider, sourceKey) {
  const stale = db
    .prepare(
      `SELECT key FROM pipeline_work
       WHERE kind = 'parse' AND key != @key
         AND status IN ${CLAIMABLE_SQL}
         AND json_extract(payload_json, '$.provider') = @provider
         AND json_extract(payload_json, '$.sourceKey') = @sourceKey`,
    )
    .all({ key, provider, sourceKey });
  for (const row of stale) {
    cancelWork('parse', row.key, 'Superseded by a newer capture of the same advert', {
      action: 'superseded',
      outcome: 'superseded',
      code: 'superseded',
    });
  }
}

function replaceQueueImages(db, key, listingId, images) {
  if (!images.length) return;
  db.prepare('DELETE FROM listing_images WHERE queue_id = ?').run(key);
  const insert = db.prepare(
    `INSERT INTO listing_images (
       id, queue_id, listing_id, position, kind, original_url, storage_path,
       content_hash, mime_type, byte_size, width, height, download_status, error, retained_until
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      Date.now() + env('FREDY_MEDIA_RETENTION_DAYS') * 86400000,
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

export function completeParse(key, listingId, status = 'completed') {
  SqliteConnection.withTransaction((db) => {
    const fullText = toParseRow(getWork('parse', key))?.capture?.fullText;
    const finished = completeWork('parse', key, {
      status,
      code: status === 'duplicate' ? 'merged_duplicate' : 'parsed',
      patch: { listingId: listingId ?? null, stage: 'completed' },
    });
    if (!finished || !listingId) return;
    saveListingText(listingId, fullText, Date.now(), db);
    db.prepare('UPDATE listing_images SET listing_id = ? WHERE queue_id = ?').run(listingId, key);
    db.prepare('UPDATE listing_extractions SET listing_id = ? WHERE queue_id = ?').run(listingId, key);
    db.prepare('UPDATE llm_call_audit SET listing_id = COALESCE(listing_id, ?) WHERE queue_id = ?').run(listingId, key);
  });
}

function jsonOrNull(value) {
  if (value == null) return null;
  return typeof value === 'string' ? value : toJson(value);
}
