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
import { CardFacts, cardFilterReasons, primaryFilterReason, primaryFilterStage } from './listingFilters.js';
import { cardEvidence, filterConfigHash, terminalVerdict } from './terminalVerdict.js';

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
 * A detail item is one provider advert. Not one advert *per job*: fetching a page
 * is job-independent work, and keying it by job meant three searches over the
 * same city fetched the same advert three times and extracted it three times to
 * reach three copies of one verdict. One wg-gesucht URL cost 76 LLM calls that
 * way. Jobs now meet at the primary key, and the per-job part — the verdict —
 * lives in listing_verdicts where it belongs.
 *
 * Price is deliberately not part of the key: repricing produces a new evidence
 * version of the same offer, not a second source identity.
 */
export function detailKey(provider, sourceKey) {
  return `${provider}|${sourceKey}`;
}

/**
 * A parse item is one *version* of the captured evidence, so unchanged evidence
 * cannot be parsed twice and changed evidence gets its own images and its own
 * extraction rather than overwriting the previous answer. The capture hash
 * already covers the provider and the source key and was never job-dependent —
 * the job prefix only ever forced one advert into several parses.
 */
export function parseKey(sourceHash) {
  return sourceHash;
}

/** Expose a detail work item under the field names the audit layer reads. */
export function toDetailRow(item) {
  if (!item) return null;
  const payload = item.payload ?? {};
  return {
    ...item,
    id: item.key,
    provider: payload.provider,
    source_key: payload.sourceKey,
    external_id: payload.externalId ?? null,
    source_url: payload.sourceUrl,
    discovery_hash: payload.discoveryHash,
    discovery: payload.discovery ?? {},
    capture_queue_id: payload.captureKey ?? null,
    livenessOnly: payload.livenessOnly === true,
  };
}

/** Expose a parse work item under the field names the finalizer reads. */
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
/**
 * The stable identity of one advert at one portal.
 *
 * A provider that cannot find its own id in a card hands back the whole URL, and
 * a URL is not an identity: wg-gesucht publishes each advert as both
 * `…?asset_id=13061845` and `…-Prenzlauer-Berg.13061845.html`, and 2651 of 4200
 * immowelt sources were keyed by URL this way. Every alias became its own source,
 * its own detail work item, and its own browser fetch, with the duplicates only
 * recognised after the page had already been downloaded. `providerListingIdentity`
 * already knows how to read the real id out of every portal's URL shapes, so it
 * decides before the fetch instead of after.
 *
 * @param {string|null|undefined} externalId what the provider extracted from the card
 * @param {string} sourceUrl canonical listing URL
 * @returns {string}
 */
function canonicalSourceKey(externalId, sourceUrl) {
  const declared = String(externalId ?? '').trim();
  if (declared && !/^https?:\/\//iu.test(declared)) return declared;
  return providerListingIdentity(sourceUrl) || sourceUrl;
}

/**
 * Register a discovered card, in the one order that does not waste work:
 * identify, dedupe, ask whether it is already decided, and only then filter.
 *
 * The old order filtered first and deduped second, which meant a card that three
 * jobs had all seen was re-decided three times a run, and the decision itself was
 * remembered on the detail work row — a row scheduled maintenance prunes after
 * thirty days. One wg-gesucht URL was re-decided 401 times in seven days, and the
 * three jobs together produced ~13,000 soft-delete events a day against ~860
 * genuinely new cards.
 *
 * @returns {{id: string, changed: boolean, deduped?: boolean, filtered?: boolean}}
 */
export function enqueueDiscovery({ jobId, provider, listing }) {
  const db = SqliteConnection.getConnection();
  const sourceUrl = canonicalUrl(listing.link);
  const sourceKey = canonicalSourceKey(listing.externalId, sourceUrl);
  const key = detailKey(provider, sourceKey);
  // Discovery timestamps are observations, not content. Excluding them stops
  // every scheduled run from requeueing an otherwise unchanged source.
  const discoveryHash = sha256(JSON.stringify({ ...listing, discoveredAt: undefined }));
  const dedupeKeys = discoveryDedupeKeys(listing);
  const identity = { jobId, provider, sourceKey, sourceUrl, listing, discoveryHash, dedupeKeys };
  const job = getJob(jobId);
  const facts = new CardFacts(listing);

  // One transaction, because a concurrent job's discovery must not slip a second
  // detail item past the gate between the check and the enqueue. The filter used
  // to run outside it, which is exactly that race.
  return db.transaction(() => {
    // Dedupe first. An advert already tied to a work item keeps that tie, and a
    // sibling that resolves to the same identity joins it instead of opening a
    // second one.
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
      // Known and settled under this configuration, on a card that has not moved.
      // Record the sighting so the source stays current, and stop.
      recordDiscoverySource(db, { ...identity, detailQueueId: key });
      return { id: key, changed: false, filtered: true };
    }

    const enqueued = enqueueWork(
      'detail',
      key,
      {
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

    // Only now, on evidence that is free to read, does the card get judged.
    const reasons = cardFilterReasons(facts, job);
    if (reasons.length) {
      // A card rejection is never fetched, never extracted and never revisited,
      // so no card-stage refusal has ever been checked against anything. 1,336
      // sources a cycle are refused on evidence nothing can audit — including 174
      // matches on the bare token `WG`, which also fires on a whole flat titled
      // "3-Zi für Studenten-WG".
      //
      // A small random sample is let through instead. This costs one LLM call
      // each and it is not merely measurement: almost every card term has a
      // sharper equivalent after extraction — `möbliert` against
      // furnishing_status, `Tausch` against listing_type, `WG` against
      // wg_room — so a sampled advert that really is what the card said is
      // refused again on better evidence and never announced, while one the card
      // got wrong is recovered rather than counted. The audit row carries the
      // term that would have refused it, so agreement can be read per term.
      if (sampledForAudit()) {
        auditWork(db, 'detail', key, { action: 'sampled', reason: primaryFilterReason(reasons), payload: { reasons } });
        return { id: key, changed: enqueued.changed, sampled: true };
      }
      const detail = toDetailRow(getWork('detail', key));
      if (detail) {
        recordSourceRejection(detail, {
          reason: primaryFilterReason(reasons),
          stage: primaryFilterStage(reasons) ?? 'discovery',
          evidenceKind: 'card',
          evidenceHash: evidence.card,
          configHash: filterConfigHash(job),
          reasons,
        });
        return { id: key, changed: enqueued.changed, filtered: true };
      }
    }
    return { id: key, changed: enqueued.changed };
  })();
}

/** Whether this card refusal is one of the few allowed through to be checked. */
function sampledForAudit() {
  const rate = env('FREDY_CARD_FILTER_AUDIT_RATE');
  return rate > 0 && Math.random() < rate;
}

/**
 * The identity claims a card can assert. Exact kinds only.
 *
 * A card carries a title, a price, a size and usually a district — enough to
 * resemble another advert, never enough to prove it is the same one. Since a
 * claim is a primary key and therefore permanent and single-owner, a wrong
 * resemblance claim asserted here would poison that bucket for every future
 * listing. Cross-provider identity waits for the image hashes, which is the
 * first evidence that actually earns it.
 */
function cardClaims(sourceUrl, provider, sourceKey) {
  const claims = [];
  const url = canonicalUrl(sourceUrl);
  if (url) claims.push({ claim: `url:${url}`, kind: 'url' });
  const providerId = providerListingIdentity(sourceUrl);
  if (providerId) claims.push({ claim: `pid:${providerId}`, kind: 'pid' });
  if (provider && sourceKey) claims.push({ claim: `src:${provider}:${sourceKey}`, kind: 'src' });
  return claims;
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
export function enqueueCapture({ provider, sourceHash, capture, images = [], listingId, detailQueueId }) {
  const db = SqliteConnection.getConnection();
  const key = parseKey(sourceHash);
  const sourceKey = canonicalSourceKey(capture.externalId, canonicalUrl(capture.sourceUrl)) || sourceHash;

  db.transaction(() => {
    supersedeOlderCaptures(db, key, provider, sourceKey);
    // The key already contains the hash, so an unchanged capture re-enqueued
    // after a restart resolves to the same row and changes nothing.
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
