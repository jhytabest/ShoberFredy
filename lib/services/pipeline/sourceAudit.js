/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { nanoid } from 'nanoid';
import SqliteConnection from '../storage/SqliteConnection.js';
import { storeAuditPayload } from '../storage/auditPayloadStorage.js';
import { claimsForListing } from '../listings/claims.js';

export function recordDiscoverySource(db, { jobId, city, provider, sourceKey, sourceUrl, discoveryHash, listing, detailQueueId }) {
  const now = Date.now();
  let source = db.prepare('SELECT * FROM listing_sources WHERE provider=? AND source_key=?').get(provider, sourceKey);
  if (!source) {
    db.prepare(`INSERT INTO listing_sources (id,provider,source_key,source_url,city,detail_queue_id,discovery_hash,first_seen_at,last_seen_at,historical)
      VALUES (?,?,?,?,?,?,?,?,?,0)`).run(nanoid(), provider, sourceKey, sourceUrl, city, detailQueueId, discoveryHash, now, now);
    source = db.prepare('SELECT * FROM listing_sources WHERE provider=? AND source_key=?').get(provider, sourceKey);
  } else {
    db.prepare('UPDATE listing_sources SET source_url=?,last_seen_at=? WHERE id=?').run(sourceUrl, now, source.id);
    if (source.listing_id) db.prepare('UPDATE listings SET last_seen_at=? WHERE id=?').run(now, source.listing_id);
  }
  if (jobId) db.prepare(`INSERT INTO discovery_origins (source_id,job_id,city,first_seen_at,last_seen_at) VALUES (?,?,?,?,?)
    ON CONFLICT(source_id,job_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(source.id, jobId, city, now, now);
  recordObservation(db, source.id, 'discovery', discoveryHash, listing, now);
  return source;
}

export function sourceForDetail(key, db = SqliteConnection.getConnection()) {
  return db.prepare('SELECT * FROM listing_sources WHERE detail_queue_id=? LIMIT 1').get(key);
}
export function sourceForParse(key, db = SqliteConnection.getConnection()) {
  return db.prepare('SELECT * FROM listing_sources WHERE parsing_queue_id=? LIMIT 1').get(key);
}
export function recordDetailCapture(detail, capture) {
  const db = SqliteConnection.getConnection();
  const source = sourceForDetail(detail.id, db);
  if (!source) throw new Error('Detail source missing');
  recordObservation(db, source.id, 'detail', capture.contentHash, capture, Date.now());
}
export function attachParsingQueue(detailKey, parseKey) {
  SqliteConnection.getConnection().prepare('UPDATE listing_sources SET parsing_queue_id=? WHERE detail_queue_id=?').run(parseKey, detailKey);
}
export function attachSourcesToListing(parseKey, listingId) {
  SqliteConnection.getConnection().prepare('UPDATE listing_sources SET listing_id=? WHERE parsing_queue_id=?').run(listingId, parseKey);
}
export function sourceIdentitiesForQueue(db, key) {
  return db.prepare('SELECT provider,source_key AS sourceKey,source_url AS sourceUrl FROM listing_sources WHERE parsing_queue_id=?').all(key);
}
export function sourceLinksForParsingQueue(key) { return sourceIdentitiesForQueue(SqliteConnection.getConnection(), key).map((s) => s.sourceUrl); }
export function sourceLinksForDetailQueue(key) { const source = sourceForDetail(key); return source ? [source.source_url] : []; }
export function identityClaimsForParsingQueue(key) { return claimsForListing({ sourceIdentities: sourceIdentitiesForQueue(SqliteConnection.getConnection(), key) }); }
export function reusableExtraction(db, key, claims, evidenceHash, { schemaVersion, promptVersion }) {
  const row = db.prepare(`SELECT queue_id,llm_json,text_model FROM listing_extractions
    WHERE queue_id != ? AND llm_json IS NOT NULL
      AND json_extract(llm_json,'$.provenance.evidenceHash')=?
      AND json_extract(llm_json,'$.provenance.schemaVersion')=?
      AND json_extract(llm_json,'$.provenance.promptVersion')=? ORDER BY parsed_at DESC LIMIT 1`)
    .get(key, evidenceHash, schemaVersion, promptVersion);
  return row ? { ...row, llm_json: JSON.parse(row.llm_json) } : null;
}
export function recordListingAudit(listingId, { queueId=null, stage, action, reason=null, payload=null }) {
  SqliteConnection.getConnection().prepare(`INSERT INTO pipeline_audit_events (listing_id,queue_id,stage,action,reason,payload_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(listingId, queueId, stage, action, reason, payload == null ? null : JSON.stringify(payload), Date.now());
}
export function recordSourceUnavailable(key, reason) {
  const source = sourceForDetail(key);
  recordListingAudit(source?.listing_id ?? null, { queueId: key, stage: 'detail', action: 'inactive', reason });
}
function recordObservation(db, sourceId, stage, hash, payload, at) {
  if (db.prepare('SELECT 1 FROM listing_source_observations WHERE source_id=? AND stage=? AND content_hash=?').get(sourceId,stage,hash)) return;
  const body = JSON.stringify(payload);
  db.prepare(`INSERT INTO listing_source_observations (id,source_id,stage,content_hash,content_bytes,observed_at,payload_sha256) VALUES (?,?,?,?,?,?,?)`)
    .run(nanoid(), sourceId, stage, hash, Buffer.byteLength(body), at, storeAuditPayload(payload, db, at));
}
