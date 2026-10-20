/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { sourceKeyFor, claimsForListing, recordClaims } from '../../../listings/claims.js';

export function up(db) {
  const now = Date.now();
  const groups = new Map();
  for (const source of db.prepare('SELECT * FROM listing_sources').all()) {
    const key = sourceKeyFor(source.provider,source.source_key,source.source_url);
    const identity = JSON.stringify([source.provider,key]);
    const group = groups.get(identity) ?? {key,sources:[]};
    group.sources.push(source); groups.set(identity,group);
  }
  db.exec(`CREATE TEMP TABLE canonical_source_map (
    old_id TEXT PRIMARY KEY,new_id TEXT NOT NULL,provider TEXT NOT NULL,
    old_key TEXT NOT NULL,new_key TEXT NOT NULL,historical INTEGER NOT NULL
  )`);
  const map = db.prepare('INSERT INTO canonical_source_map VALUES (?,?,?,?,?,?)');
  const update = db.prepare(`UPDATE listing_sources SET first_seen_at=?,last_seen_at=?,historical=? WHERE id=?`);
  for (const {key,sources} of groups.values()) {
    sources.sort((a,b)=>Number(b.source_key===key)-Number(a.source_key===key) || a.first_seen_at-b.first_seen_at || a.id.localeCompare(b.id));
    const winner=sources[0];
    const historical=Number(sources.some((s)=>s.historical));
    update.run(Math.min(...sources.map((s)=>s.first_seen_at)),Math.max(...sources.map((s)=>s.last_seen_at)),historical,winner.id);
    for (const source of sources) map.run(source.id,winner.id,source.provider,source.source_key,key,historical);
  }
  db.exec(`
    INSERT INTO discovery_origins (source_id,job_id,city,first_seen_at,last_seen_at)
      SELECT m.new_id,o.job_id,MIN(o.city),MIN(o.first_seen_at),MAX(o.last_seen_at)
      FROM discovery_origins o JOIN canonical_source_map m ON m.old_id=o.source_id
      GROUP BY m.new_id,o.job_id
      ON CONFLICT(source_id,job_id) DO UPDATE SET
        first_seen_at=MIN(first_seen_at,excluded.first_seen_at),last_seen_at=MAX(last_seen_at,excluded.last_seen_at);
    DELETE FROM discovery_origins WHERE source_id IN (SELECT old_id FROM canonical_source_map WHERE old_id!=new_id);
    UPDATE OR IGNORE listing_source_observations SET source_id=(SELECT new_id FROM canonical_source_map WHERE old_id=source_id)
      WHERE source_id IN (SELECT old_id FROM canonical_source_map WHERE old_id!=new_id);
    DELETE FROM listing_source_observations WHERE source_id IN (SELECT old_id FROM canonical_source_map WHERE old_id!=new_id);
    UPDATE pipeline_audit_events SET source_id=(SELECT new_id FROM canonical_source_map WHERE old_id=source_id)
      WHERE source_id IN (SELECT old_id FROM canonical_source_map WHERE old_id!=new_id);
  `);
  db.prepare(`INSERT INTO pipeline_audit_events (source_id,listing_id,stage,action,payload_json,created_at)
    SELECT m.new_id,s.listing_id,'migration','source_alias_normalized',
      json_object('oldSourceId',m.old_id,'oldKey',m.old_key,'newKey',m.new_key),?
    FROM canonical_source_map m JOIN listing_sources s ON s.id=m.old_id WHERE m.old_id!=m.new_id OR m.old_key!=m.new_key`).run(now);
  db.exec(`DELETE FROM listing_sources WHERE id IN (SELECT old_id FROM canonical_source_map WHERE old_id!=new_id);
    UPDATE listing_sources SET source_key=(SELECT new_key FROM canonical_source_map WHERE old_id=id);
  `);
  db.prepare(`INSERT OR IGNORE INTO notification_suppressions
    SELECT listing_id,'historical_source_alias',? FROM listing_sources WHERE historical=1 AND listing_id IS NOT NULL`).run(now);
  db.prepare(`INSERT INTO pipeline_audit_events (queue_id,stage,action,reason,created_at)
    SELECT w.key,'migration','cancelled','Historical source alias is outside the new-only stream',?
    FROM pipeline_work w WHERE w.kind IN ('detail','parse','notify') AND w.status IN ('pending','processing','retry','deferred')
      AND (EXISTS (SELECT 1 FROM canonical_source_map m WHERE m.historical=1
        AND m.provider=json_extract(w.payload_json,'$.provider') AND (m.old_key=json_extract(w.payload_json,'$.sourceKey') OR m.new_key=json_extract(w.payload_json,'$.sourceKey')))
        OR (w.kind='notify' AND EXISTS (SELECT 1 FROM notification_suppressions s WHERE s.listing_id=json_extract(w.payload_json,'$.listingId'))))`).run(now);
  db.prepare(`UPDATE pipeline_work AS w SET status='cancelled',lease_until=NULL,outcome='cancelled',outcome_code='already_decided',
    outcome_note='Historical source alias is outside the new-only stream',updated_at=?
    WHERE kind IN ('detail','parse','notify') AND status IN ('pending','processing','retry','deferred')
      AND (EXISTS (SELECT 1 FROM canonical_source_map m WHERE m.historical=1
        AND m.provider=json_extract(w.payload_json,'$.provider') AND (m.old_key=json_extract(w.payload_json,'$.sourceKey') OR m.new_key=json_extract(w.payload_json,'$.sourceKey')))
        OR (kind='notify' AND EXISTS (SELECT 1 FROM notification_suppressions s WHERE s.listing_id=json_extract(w.payload_json,'$.listingId'))))`).run(now);
  db.exec(`DELETE FROM listing_claims WHERE kind IN ('src','pid','url')`);
  for (const source of db.prepare('SELECT * FROM listing_sources WHERE listing_id IS NOT NULL').all())
    recordClaims(db,source.listing_id,claimsForListing({sourceIdentities:[{provider:source.provider,sourceKey:source.source_key,sourceUrl:source.source_url}]}),now);
  db.exec('DROP TABLE canonical_source_map');
  if (db.pragma('foreign_key_check').length) throw new Error('Canonical source identity migration left foreign-key violations');
}
