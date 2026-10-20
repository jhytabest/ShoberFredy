/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { nanoid } from 'nanoid';
import { DEFAULT_FILTERS } from '../../../pipeline/listingFilters.js';
import { canonicalUrl, claimsForListing, recordClaims, addressesCompatible } from '../../../listings/claims.js';
import { normalizeExtraction, attributesFromExtraction } from '../../../listings/standardizedFacts.js';

export function up(db) {
  const now = Date.now();
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY id').all();
  const notifications = jobs.map((j) => parse(j.notify)).filter((n) => n?.token && n.chatId);
  const notify = notifications[0] ?? {};
  if (notifications.some((n) => n.token !== notify.token || String(n.chatId) !== String(notify.chatId) || (n.threadId ?? null) !== (notify.threadId ?? null)))
    throw new Error('Discovery jobs have conflicting Telegram destinations; consolidate them before migrating');
  const polygons = new Map();
  for (const job of jobs) for (const feature of parse(job.spatial_filter)?.features ?? [])
    polygons.set(JSON.stringify(feature.geometry), feature);
  const filters = { ...DEFAULT_FILTERS, spatialFilter: polygons.size ? { type: 'FeatureCollection', features: [...polygons.values()] } : null };
  db.exec(`
    CREATE TABLE pipeline_config (id INTEGER PRIMARY KEY CHECK(id=1), filters_json TEXT NOT NULL, notify_json TEXT NOT NULL, cutover_at INTEGER NOT NULL);
    CREATE TABLE listing_decisions (
      listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL CHECK(verdict IN ('accepted','rejected')), reasons_json TEXT NOT NULL,
      config_hash TEXT NOT NULL, feature_hash TEXT NOT NULL, decided_at INTEGER NOT NULL
    );
    CREATE TABLE discovery_origins (
      source_id TEXT NOT NULL REFERENCES listing_sources(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL, city TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      PRIMARY KEY(source_id,job_id)
    );
    ALTER TABLE listings ADD COLUMN geocode_accuracy TEXT;
    ALTER TABLE listings ADD COLUMN representative_queue_id TEXT;
  `);
  db.prepare('INSERT INTO pipeline_config VALUES (1,?,?,?)').run(JSON.stringify(filters), JSON.stringify(notify), now);
  // Archive decisions and source refusals before retiring their job-scoped tables.
  db.prepare(`INSERT INTO pipeline_audit_events (listing_id,stage,action,reason,payload_json,created_at)
    SELECT listing_id,'migration','legacy_job_decision',reason,
      json_object('jobId',job_id,'verdict',verdict,'configHash',config_hash,'evidenceHash',evidence_hash,'decidedAt',decided_at,'notifiedAt',notified_at),?
    FROM listing_verdicts`).run(now);
  db.prepare(`INSERT INTO pipeline_audit_events (source_id,stage,action,reason,payload_json,created_at)
    SELECT source_id,'migration','legacy_card_rejection',reason,json_object('stage',stage,'configHash',config_hash,'decidedAt',decided_at),?
    FROM source_rejections`).run(now);
  db.prepare(`INSERT INTO pipeline_audit_events (listing_id,stage,action,reason,payload_json,created_at)
    SELECT listing_id,'migration','legacy_delivery_suppression',reason,json_object('jobId',job_id),?
    FROM notification_suppressions`).run(now);
  db.exec(`
    DROP TABLE listing_verdicts;
    DROP TABLE source_rejections;
    DROP TABLE notification_suppressions;
    DROP TABLE source_identity_keys;
    DROP INDEX IF EXISTS idx_notify_work_owner;
    CREATE TABLE notification_suppressions (
      listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
      reason TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE notification_receipts_next (
      delivery_key TEXT NOT NULL, listing_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      topic_id INTEGER NOT NULL DEFAULT 0, message_id INTEGER NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(chat_id,message_id)
    );
  `);
  const insertReceipt = db.prepare('INSERT OR IGNORE INTO notification_receipts_next VALUES (?,?,?,?,?,?)');
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  for (const receipt of db.prepare('SELECT * FROM notification_receipts').all()) {
    const topic = Number(parse(jobById.get(receipt.job_id)?.notify)?.threadId) || 0;
    const chat = BigInt(receipt.chat_id).toString();
    insertReceipt.run(JSON.stringify([receipt.listing_id, chat, topic]), receipt.listing_id, chat, topic, receipt.message_id, receipt.received_at);
  }
  db.exec(`DROP TABLE notification_receipts; ALTER TABLE notification_receipts_next RENAME TO notification_receipts;
    CREATE INDEX idx_notification_receipts_destination ON notification_receipts(listing_id,chat_id,topic_id);
    CREATE INDEX migration_source_identity ON listing_sources(provider,source_key);
    CREATE TEMP TABLE source_map (old_id TEXT PRIMARY KEY,new_id TEXT NOT NULL);
    INSERT INTO source_map SELECT id, FIRST_VALUE(id) OVER (PARTITION BY provider,source_key ORDER BY first_seen_at,id) FROM listing_sources;
    CREATE TABLE listing_sources_next (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, source_key TEXT NOT NULL, source_url TEXT NOT NULL,
      city TEXT, detail_queue_id TEXT, parsing_queue_id TEXT,
      listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
      discovery_hash TEXT, extraction_version TEXT, historical INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,
      UNIQUE(provider,source_key)
    );
    INSERT INTO listing_sources_next
      SELECT s.id,s.provider,s.source_key,s.source_url,j.city,s.detail_queue_id,
        (SELECT x.parsing_queue_id FROM listing_sources x WHERE x.provider=s.provider AND x.source_key=s.source_key AND x.parsing_queue_id IS NOT NULL ORDER BY x.last_seen_at DESC LIMIT 1),
        (SELECT x.listing_id FROM listing_sources x WHERE x.provider=s.provider AND x.source_key=s.source_key AND x.listing_id IS NOT NULL ORDER BY x.last_seen_at DESC LIMIT 1),
        NULL,NULL,1,
        (SELECT MIN(x.first_seen_at) FROM listing_sources x WHERE x.provider=s.provider AND x.source_key=s.source_key),
        (SELECT MAX(x.last_seen_at) FROM listing_sources x WHERE x.provider=s.provider AND x.source_key=s.source_key)
      FROM listing_sources s LEFT JOIN jobs j ON j.id=s.job_id
      WHERE s.id IN (SELECT DISTINCT new_id FROM source_map);
    INSERT INTO discovery_origins
      SELECT m.new_id,s.job_id,j.city,MIN(s.first_seen_at),MAX(s.last_seen_at)
      FROM listing_sources s JOIN source_map m ON m.old_id=s.id LEFT JOIN jobs j ON j.id=s.job_id
      GROUP BY m.new_id,s.job_id;
    UPDATE OR IGNORE listing_source_observations SET source_id=(SELECT new_id FROM source_map WHERE old_id=source_id)
      WHERE source_id IN (SELECT old_id FROM source_map WHERE old_id!=new_id);
    DELETE FROM listing_source_observations WHERE source_id IN (SELECT old_id FROM source_map WHERE old_id!=new_id);
    UPDATE pipeline_audit_events SET source_id=(SELECT new_id FROM source_map WHERE old_id=source_id)
      WHERE source_id IN (SELECT old_id FROM source_map WHERE old_id!=new_id);
    DELETE FROM listing_claims;
    DROP TABLE listing_sources;
    ALTER TABLE listing_sources_next RENAME TO listing_sources;
    DROP TABLE source_map;
    CREATE INDEX idx_listing_sources_detail ON listing_sources(detail_queue_id);
    CREATE INDEX idx_listing_sources_parsing ON listing_sources(parsing_queue_id);
    CREATE INDEX idx_listing_sources_listing ON listing_sources(listing_id);
    CREATE INDEX idx_listing_sources_url ON listing_sources(source_url);
    CREATE INDEX idx_reusable_extraction ON listing_extractions(
      json_extract(llm_json,'$.provenance.evidenceHash'),json_extract(llm_json,'$.provenance.schemaVersion'),json_extract(llm_json,'$.provenance.promptVersion')
    ) WHERE llm_json IS NOT NULL;
  `);
  // Resolve the latest extraction by advert ID, not the previously merged listing.
  const extractions = new Map();
  for (const row of db.prepare(`SELECT e.*,json_extract(w.payload_json,'$.provider') provider,json_extract(w.payload_json,'$.sourceKey') source_key
    FROM listing_extractions e JOIN pipeline_work w ON w.kind='parse' AND w.key=e.queue_id
    WHERE e.llm_json IS NOT NULL ORDER BY e.parsed_at DESC`).all()) {
    const key = JSON.stringify([row.provider,row.source_key]);
    if (!extractions.has(key)) extractions.set(key,row);
  }
  const groups = new Map();
  for (const source of db.prepare('SELECT * FROM listing_sources WHERE listing_id IS NOT NULL ORDER BY first_seen_at,id').all()) {
    const group = groups.get(source.listing_id) ?? [];
    const extraction = extractions.get(JSON.stringify([source.provider,source.source_key]));
    group.push({ source, extraction, facts: normalizeExtraction(parse(extraction?.llm_json)) });
    groups.set(source.listing_id,group);
  }
  for (const [listingId, group] of groups) {
    const conflicting = group.some((a,i) => group.slice(i+1).some((b) => contradicts(a.facts,b.facts)));
    if (!conflicting) {
      const queue = group.find((g) => g.extraction)?.extraction.queue_id;
      if (queue) db.prepare('UPDATE listings SET representative_queue_id=? WHERE id=?').run(queue,listingId);
      continue;
    }
    for (const [index, { source, extraction, facts }] of group.entries()) {
      let attributes;
      try { attributes = facts && attributesFromExtraction(parse(extraction.llm_json)); } catch { attributes = null; }
      // An unassignable historical source stays archived but cannot assert an identity match.
      if (!attributes) {
        db.prepare('UPDATE listing_sources SET listing_id=NULL WHERE id=?').run(source.id);
        archiveRepair(db,listingId,source.id,null,now);
        continue;
      }
      const id = index === 0 ? listingId : nanoid();
      const image = db.prepare('SELECT original_url FROM listing_images WHERE queue_id=? ORDER BY position LIMIT 1').get(extraction.queue_id)?.original_url ?? null;
      if (id !== listingId) db.prepare(`INSERT INTO listings (id,created_at,last_seen_at,provider,title,link) VALUES (?,?,?,?,?,?)`)
        .run(id,source.first_seen_at,source.last_seen_at,source.provider,facts.title ?? '',source.source_url);
      db.prepare(`UPDATE listings SET provider=?,title=?,link=?,address=?,price=?,size=?,rooms=?,image_url=?,
        latitude=NULL,longitude=NULL,geocode_accuracy=NULL,representative_queue_id=?,market=COALESCE(market,'berlin') WHERE id=?`)
        .run(source.provider,facts.title ?? '',canonicalUrl(source.source_url),facts.address,facts.rent.cold ?? facts.rent.warm,
          facts.size_sqm,facts.rooms,image,extraction.queue_id,id);
      db.prepare(`INSERT INTO listing_attributes (listing_id,data,parsed_at) VALUES (?,?,?)
        ON CONFLICT(listing_id) DO UPDATE SET data=excluded.data,parsed_at=excluded.parsed_at`).run(id,JSON.stringify(attributes),extraction.parsed_at);
      db.prepare('UPDATE listing_sources SET listing_id=? WHERE id=?').run(id,source.id);
      db.prepare(`UPDATE listing_extractions SET listing_id=? WHERE queue_id IN (
        SELECT key FROM pipeline_work WHERE kind='parse' AND json_extract(payload_json,'$.provider')=? AND json_extract(payload_json,'$.sourceKey')=?)`)
        .run(id,source.provider,source.source_key);
      db.prepare('UPDATE listing_images SET listing_id=? WHERE queue_id=?').run(id,extraction.queue_id);
      db.prepare('DELETE FROM listing_texts WHERE listing_id=?').run(id);
      const capture = db.prepare(`SELECT p.body_json FROM listing_source_observations o JOIN audit_payloads p ON p.sha256=o.payload_sha256
        WHERE o.source_id=? AND o.stage='detail' ORDER BY o.observed_at DESC LIMIT 1`).get(source.id);
      const text = parse(capture?.body_json)?.fullText;
      if (text) db.prepare('INSERT INTO listing_texts VALUES (?,?,?,?)').run(id,text,extraction.queue_id,now);
      archiveRepair(db,listingId,source.id,id,now);
    }
  }
  // Every historical canonical, including newly split groups, remains non-deliverable.
  db.prepare(`INSERT INTO notification_suppressions SELECT id,'pre_cutover_history',? FROM listings`).run(now);
  db.prepare(`INSERT INTO pipeline_audit_events (queue_id,stage,action,reason,created_at)
    SELECT key,'migration','cancelled','Pre-cutover work retired from the new-only stream',? FROM pipeline_work
    WHERE kind IN ('detail','parse','notify') AND status IN ('pending','processing','retry','deferred')`).run(now);
  db.prepare(`UPDATE pipeline_work SET status='cancelled',lease_until=NULL,outcome='cancelled',outcome_code='already_decided',
    outcome_note='Pre-cutover work retired from the new-only stream',updated_at=?
    WHERE kind IN ('detail','parse','notify') AND status IN ('pending','processing','retry','deferred')`).run(now);
  for (const source of db.prepare('SELECT * FROM listing_sources WHERE listing_id IS NOT NULL').all())
    recordClaims(db,source.listing_id,claimsForListing({ sourceIdentities:[{ provider:source.provider,sourceKey:source.source_key,sourceUrl:source.source_url }] }),now);
  // Historical images are eligible only from each coherent representative extraction.
  for (const row of db.prepare(`SELECT l.id,i.content_hash FROM listings l JOIN listing_images i ON i.queue_id=l.representative_queue_id WHERE i.content_hash IS NOT NULL`).all())
    recordClaims(db,row.id,[{kind:'img',claim:`img:${row.content_hash}`}],now);
  for (const column of ['blacklist','intent_filter','notify','spatial_filter','spec_filter']) db.exec(`ALTER TABLE jobs DROP COLUMN ${column}`);
  const violations = db.pragma('foreign_key_check');
  if (violations.length) throw new Error(`Shared pipeline migration left ${violations.length} foreign-key violations`);
}
function parse(value) { try { return JSON.parse(value); } catch { return null; } }
function contradicts(a,b) {
  if (!a || !b) return false;
  if (a.floor != null && b.floor != null && a.floor !== b.floor) return true;
  if (a.rooms != null && b.rooms != null && Math.abs(a.rooms-b.rooms)>0.01) return true;
  if (a.size_sqm != null && b.size_sqm != null && Math.abs(a.size_sqm-b.size_sqm)>Math.min(1,Math.max(a.size_sqm,b.size_sqm)*0.01)) return true;
  return Boolean(a.address && b.address && !addressesCompatible(a.address,b.address));
}
function archiveRepair(db,oldListingId,sourceId,newListingId,now) {
  db.prepare(`INSERT INTO pipeline_audit_events (source_id,listing_id,stage,action,payload_json,created_at) VALUES (?,?,'migration','identity_repaired',?,?)`)
    .run(sourceId,newListingId ?? oldListingId,JSON.stringify({previousListingId:oldListingId,newListingId,historical:true}),now);
}
