/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';

/**
 * Keep every discovered source independently from the canonical listing it
 * eventually belongs to. Dedupe can now merge sources without deleting their
 * cards, detail captures, links, or stage decisions.
 */
export function up(db) {
  const now = Date.now();

  addColumn(db, 'listings', "source_urls_json TEXT NOT NULL DEFAULT '[]'");

  // Older discovery hashes included the observation timestamp, which made an
  // unchanged card look new on every scheduled scan. Rewrite them in place so
  // deploying this migration does not requeue the complete history once.
  const discoveryRows = db.prepare('SELECT id, discovery_json FROM detail_fetch_queue').all();
  const updateDiscoveryHash = db.prepare('UPDATE detail_fetch_queue SET discovery_hash = ? WHERE id = ?');
  for (const row of discoveryRows) {
    updateDiscoveryHash.run(stableDiscoveryHash(row.discovery_json), row.id);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_sources (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_url TEXT NOT NULL,
      detail_queue_id TEXT,
      parsing_queue_id TEXT,
      listing_id TEXT,
      representative_source_id TEXT,
      dedupe_stage TEXT,
      dedupe_keys_json TEXT NOT NULL DEFAULT '[]',
      pre_llm_hidden_reason TEXT,
      post_llm_hidden_reason TEXT,
      discovery_json TEXT NOT NULL,
      capture_json TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      UNIQUE (job_id, provider, source_key),
      FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE,
      FOREIGN KEY (detail_queue_id) REFERENCES detail_fetch_queue (id) ON DELETE SET NULL,
      FOREIGN KEY (parsing_queue_id) REFERENCES parsing_queue (id) ON DELETE SET NULL,
      FOREIGN KEY (listing_id) REFERENCES listings (id) ON DELETE SET NULL,
      FOREIGN KEY (representative_source_id) REFERENCES listing_sources (id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_listing_sources_url
      ON listing_sources (job_id, source_url);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_detail
      ON listing_sources (detail_queue_id);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_parsing
      ON listing_sources (parsing_queue_id);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_listing
      ON listing_sources (listing_id);

    CREATE TABLE IF NOT EXISTS listing_source_observations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('discovery', 'detail')),
      content_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      UNIQUE (source_id, stage, content_hash),
      FOREIGN KEY (source_id) REFERENCES listing_sources (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_listing_source_observations_source
      ON listing_source_observations (source_id, stage, observed_at);

    CREATE TABLE IF NOT EXISTS pipeline_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT,
      listing_id TEXT,
      queue_id TEXT,
      stage TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (source_id) REFERENCES listing_sources (id) ON DELETE SET NULL,
      FOREIGN KEY (listing_id) REFERENCES listings (id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pipeline_audit_source
      ON pipeline_audit_events (source_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pipeline_audit_listing
      ON pipeline_audit_events (listing_id, created_at);
  `);

  db.prepare(
    `UPDATE listing_sources
     SET listing_id = (
       SELECT l.id FROM listings l
       WHERE l.job_id = listing_sources.job_id
         AND l.provider = listing_sources.provider
         AND (
           l.hash = listing_sources.source_key OR
           (l.link IS NOT NULL AND l.link = listing_sources.source_url)
         )
       ORDER BY l.created_at DESC
       LIMIT 1
     )
     WHERE listing_id IS NULL
       AND EXISTS (
         SELECT 1 FROM listings l
         WHERE l.job_id = listing_sources.job_id
           AND l.provider = listing_sources.provider
           AND (
             l.hash = listing_sources.source_key OR
             (l.link IS NOT NULL AND l.link = listing_sources.source_url)
           )
       )`,
  ).run();

  db.prepare(
    `INSERT OR IGNORE INTO listing_sources (
       id, job_id, provider, source_key, source_url, detail_queue_id,
       parsing_queue_id, listing_id, discovery_json, capture_json,
       first_seen_at, last_seen_at
     )
     SELECT 'detail:' || d.id, d.job_id, d.provider, d.source_key, d.source_url,
       d.id, d.capture_queue_id, q.listing_id, d.discovery_json, d.capture_json,
       d.created_at, d.updated_at
     FROM detail_fetch_queue d
     LEFT JOIN parsing_queue q ON q.id = d.capture_queue_id`,
  ).run();

  db.prepare(
    `INSERT OR IGNORE INTO listing_source_observations (
       id, source_id, stage, content_hash, payload_json, observed_at
     )
     SELECT 'discovery:' || d.id, 'detail:' || d.id, 'discovery',
       d.discovery_hash, d.discovery_json, d.created_at
     FROM detail_fetch_queue d`,
  ).run();

  db.prepare(
    `INSERT OR IGNORE INTO listing_source_observations (
       id, source_id, stage, content_hash, payload_json, observed_at
     )
     SELECT 'capture:' || d.id, 'detail:' || d.id, 'detail',
       lower(hex(randomblob(32))), d.capture_json, COALESCE(d.completed_at, d.updated_at)
     FROM detail_fetch_queue d
     WHERE d.capture_json IS NOT NULL`,
  ).run();

  db.prepare(
    `INSERT OR IGNORE INTO listing_sources (
       id, job_id, provider, source_key, source_url, listing_id,
       discovery_json, first_seen_at, last_seen_at
     )
     SELECT 'listing:' || l.id, l.job_id, l.provider, COALESCE(l.hash, l.id),
       COALESCE(l.link, ''), l.id,
       json_object('id', COALESCE(l.hash, l.id), 'link', l.link),
       COALESCE(l.created_at, ?), COALESCE(l.created_at, ?)
     FROM listings l
     WHERE NOT EXISTS (
       SELECT 1 FROM listing_sources s WHERE s.listing_id = l.id
     )`,
  ).run(now, now);

  db.prepare(
    `UPDATE listings
     SET source_urls_json = CASE
       WHEN EXISTS (
         SELECT 1 FROM listing_sources s
         WHERE s.listing_id = listings.id AND s.source_url != ''
       ) THEN (
         SELECT json_group_array(source_url)
         FROM (
           SELECT DISTINCT s.source_url
           FROM listing_sources s
           WHERE s.listing_id = listings.id AND s.source_url != ''
           ORDER BY s.first_seen_at
         )
       )
       WHEN link IS NULL OR link = '' THEN '[]'
       ELSE json_array(link)
     END`,
  ).run();
}

function stableDiscoveryHash(discoveryJson) {
  try {
    const discovery = JSON.parse(discoveryJson || '{}');
    delete discovery.discoveredAt;
    return crypto.createHash('sha256').update(JSON.stringify(discovery)).digest('hex');
  } catch {
    return crypto
      .createHash('sha256')
      .update(String(discoveryJson || ''))
      .digest('hex');
  }
}

function addColumn(db, table, definition) {
  const name = definition.split(/\s+/)[0];
  if (
    !db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((column) => column.name === name)
  ) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}
