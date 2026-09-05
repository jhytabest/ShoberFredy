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
  auditWork,
  cancelWork,
  completeWork,
  enqueueWork,
  getWork,
  patchWorkPayload,
} from './workQueue.js';
import {
  attachParsingQueue,
  findDiscoveryRepresentative,
  markDiscoveryDuplicate,
  recordSourceRejection,
  recordDiscoverySource,
} from './sourceAudit.js';
import { canonicalUrl, discoveryDedupeKeys, providerListingIdentity } from '../listings/claims.js';
import {
  CardFacts,
  cardFilterReasons,
  primaryFilterReason,
  primaryFilterStage,
  primaryFilterTerm,
} from './listingFilters.js';
import { cardEvidence, filterConfigHash, terminalVerdict } from './terminalVerdict.js';

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
    source_key: payload.sourceKey,
    external_id: payload.externalId ?? null,
    source_url: payload.sourceUrl,
    discovery_hash: payload.discoveryHash,
    discovery: payload.discovery ?? {},
    card_rejection: payload.cardRejection ?? null,
    card_rejection_job_id: payload.cardRejectionJobId ?? null,
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
    card_rejection: payload.cardRejection ?? null,
    card_rejection_job_id: payload.cardRejectionJobId ?? null,
    llm_attempt_count: Number(payload.llmAttempts || 0),
    geocode_attempt_count: Number(payload.geocodeAttempts || 0),
    capture: payload.capture ?? {},
  };
}

function canonicalSourceKey(externalId, sourceUrl) {
  const declared = String(externalId ?? '').trim();
  if (declared && !/^https?:\/\//iu.test(declared)) return declared;
  return providerListingIdentity(sourceUrl) || sourceUrl;
}

export function enqueueDiscovery({ jobId, provider, listing }) {
  const db = SqliteConnection.getConnection();
  const sourceUrl = canonicalUrl(listing.link);
  const sourceKey = canonicalSourceKey(listing.externalId, sourceUrl);
  const key = detailKey(provider, sourceKey);
  const discoveryHash = sha256(JSON.stringify({ ...listing, discoveredAt: undefined }));
  const dedupeKeys = discoveryDedupeKeys(listing);
  const identity = { jobId, provider, sourceKey, sourceUrl, listing, discoveryHash, dedupeKeys };
  const job = getJob(jobId);
  const facts = new CardFacts(listing);

  return db.transaction(() => {
    if (!getWork('detail', key)) {
      const representative = findDiscoveryRepresentative(db, identity);
      if (representative) {
        const source = recordDiscoverySource(db, { ...identity, detailQueueId: representative.detail_queue_id });
        markDiscoveryDuplicate(db, source.id, representative);
        return { id: representative.detail_queue_id, changed: true, deduped: true };
      }
    }

    const evidence = { card: cardEvidence(facts) };
    const decided = terminalVerdict(db, { claims: cardClaims(sourceUrl, provider, sourceKey), job, evidence });
    if (decided.decided) {
      recordDiscoverySource(db, { ...identity, detailQueueId: key });
      return { id: key, changed: false, filtered: true };
    }

    const reasons = cardFilterReasons(facts, job);
    const sampled = reasons.length > 0 && sampledForAudit();
    const previous = getWork('detail', key);
    const revive = !reasons.length && previous?.status === 'cancelled' && previous?.outcome_code === 'filtered';
    const enqueued = enqueueWork(
      'detail',
      key,
      {
        provider,
        market: job.market,
        sourceKey,
        externalId: listing.externalId ?? null,
        sourceUrl,
        discoveryHash,
        discovery: listing,
        cardRejection: sampled ? reasons : null,
        cardRejectionJobId: sampled ? jobId : null,
      },
      { mode: revive ? 'reset' : 'fingerprint', fingerprintKey: 'discoveryHash' },
    );
    recordDiscoverySource(db, { ...identity, detailQueueId: key });

    if (reasons.length) {
      if (sampled) {
        auditWork('detail', key, { action: 'sampled', reason: primaryFilterReason(reasons), payload: { reasons } }, db);
        return { id: key, changed: enqueued.changed, sampled: true };
      }
      const detail = toDetailRow(getWork('detail', key));
      if (detail) {
        recordSourceRejection(detail, {
          reason: primaryFilterReason(reasons),
          reasonTerm: primaryFilterTerm(reasons),
          stage: primaryFilterStage(reasons) ?? 'discovery',
          evidenceKind: 'card',
          evidenceHash: evidence.card,
          configHash: filterConfigHash(job),
          jobId,
          reasons,
        });
        return { id: key, changed: enqueued.changed, filtered: true };
      }
    }
    return { id: key, changed: enqueued.changed };
  })();
}

function sampledForAudit() {
  const rate = env('FREDY_CARD_FILTER_AUDIT_RATE');
  return rate > 0 && Math.random() < rate;
}

function cardClaims(sourceUrl, provider, sourceKey) {
  const claims = [];
  const url = canonicalUrl(sourceUrl);
  if (url) claims.push({ claim: `url:${url}`, kind: 'url' });
  const providerId = providerListingIdentity(sourceUrl);
  if (providerId) claims.push({ claim: `pid:${providerId}`, kind: 'pid' });
  if (provider && sourceKey) claims.push({ claim: `src:${provider}:${sourceKey}`, kind: 'src' });
  return claims;
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
  provider,
  sourceHash,
  capture,
  images = [],
  listingId,
  detailQueueId,
  cardRejection = null,
  cardRejectionJobId = null,
}) {
  const db = SqliteConnection.getConnection();
  const key = parseKey(sourceHash);
  const sourceKey = canonicalSourceKey(capture.externalId, canonicalUrl(capture.sourceUrl)) || sourceHash;

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
        cardRejection,
        cardRejectionJobId,
        capture,
      },
      { mode: 'fingerprint', fingerprintKey: 'sourceHash' },
    );
    replaceQueueImages(db, key, listingId, images);
  })();

  if (detailQueueId) attachParsingQueue(detailQueueId, key);
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
