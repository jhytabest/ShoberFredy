/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Schema v4 separates source discovery/detail acquisition from semantic LLM
 * parsing and moves market rating behind its own durable queue. Existing v3
 * attributes remain readable while listings are refreshed; no listing/media
 * rows are deleted by this migration.
 */
export function up(db) {
  const now = Date.now();

  addColumn(db, 'listings', 'inactive_at INTEGER');
  addColumn(db, 'listings', 'inactive_reason TEXT');
  addColumn(db, 'listing_attributes', 'address_json TEXT');
  addColumn(db, 'listing_attributes', 'availability_precision TEXT');
  addColumn(db, 'listing_attributes', 'available_until TEXT');
  addColumn(db, 'listing_attributes', 'furnishing_status TEXT');
  addColumn(db, 'listing_attributes', 'pets_policy TEXT');
  addColumn(db, 'listing_attributes', 'smoking_policy TEXT');
  addColumn(db, 'listing_attributes', 'lease_type TEXT');
  addColumn(db, 'listing_attributes', 'minimum_lease_months INTEGER');
  addColumn(db, 'listing_attributes', 'maximum_occupants INTEGER');
  addColumn(db, 'listing_attributes', 'amenities_absent_json TEXT');
  addColumn(db, 'listing_attributes', 'rent_inclusions_json TEXT');
  addColumn(db, 'listing_attributes', 'requirements_json TEXT');
  addColumn(db, 'listing_attributes', 'conflicts_json TEXT');
  addColumn(db, 'listing_attributes', 'recurring_costs_json TEXT');
  addColumn(db, 'listing_attributes', 'one_time_buyout_eur REAL');

  db.exec(`
    CREATE TABLE detail_fetch_queue (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      source_key TEXT NOT NULL,
      external_id TEXT,
      source_url TEXT NOT NULL,
      discovery_json TEXT NOT NULL,
      discovery_hash TEXT NOT NULL,
      capture_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'retry', 'completed', 'inactive', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      capture_queue_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE (job_id, provider, source_key),
      FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE,
      FOREIGN KEY (capture_queue_id) REFERENCES parsing_queue (id) ON DELETE SET NULL
    );

    CREATE INDEX idx_detail_fetch_due
      ON detail_fetch_queue (job_id, provider, status, next_attempt_at, lease_until);
    CREATE INDEX idx_detail_fetch_url
      ON detail_fetch_queue (provider, source_url);

    CREATE TABLE rating_queue (
      listing_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      notify INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'retry', 'completed', 'unrated', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (listing_id) REFERENCES listings (id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
    );

    CREATE INDEX idx_rating_queue_due
      ON rating_queue (status, next_attempt_at, lease_until);

    INSERT INTO parsing_queue (
      id, queue_kind, schema_version, job_id, provider, source_hash, listing_id,
      external_id, source_url, discovered_at, capture_json, stage, status,
      attempt_count, llm_attempt_count, geocode_attempt_count, lease_until,
      next_attempt_at, last_error, created_at, updated_at, completed_at
    )
    SELECT lower(hex(randomblob(16))), q.queue_kind, 4, q.job_id, q.provider,
      q.source_hash, q.listing_id, q.external_id, q.source_url, q.discovered_at,
      q.capture_json, 'captured', 'pending', 0, 0, 0, NULL, 0, NULL,
      ${now}, ${now}, NULL
    FROM parsing_queue q
    WHERE q.schema_version = 3
      AND q.status IN ('pending', 'retry', 'processing')
      AND COALESCE(json_extract(q.capture_json, '$.detailCaptureFailed'), 0) = 0
      AND LENGTH(TRIM(COALESCE(json_extract(q.capture_json, '$.fullText'), ''))) > 0
      AND NOT EXISTS (
        SELECT 1 FROM parsing_queue newer
        WHERE newer.queue_kind = q.queue_kind
          AND newer.job_id = q.job_id
          AND newer.provider = q.provider
          AND newer.source_hash = q.source_hash
          AND newer.schema_version = 4
      );

    INSERT OR IGNORE INTO parsing_queue (
      id, queue_kind, schema_version, job_id, provider, source_hash, listing_id,
      external_id, source_url, discovered_at, capture_json, stage, status,
      attempt_count, llm_attempt_count, geocode_attempt_count, lease_until,
      next_attempt_at, last_error, created_at, updated_at, completed_at
    )
    SELECT lower(hex(randomblob(16))), 'backfill', 4, l.job_id, l.provider,
      COALESCE(l.hash, l.id), l.id, COALESCE(l.hash, l.id), l.link,
      COALESCE(l.created_at, ${now}),
      COALESCE(
        (
          SELECT q.capture_json FROM parsing_queue q
          WHERE q.listing_id = l.id AND q.capture_json IS NOT NULL
          ORDER BY q.schema_version DESC, q.updated_at DESC LIMIT 1
        ),
        json_object(
          'provider', l.provider,
          'externalId', COALESCE(l.hash, l.id),
          'sourceUrl', l.link,
          'discoveredAt', COALESCE(l.created_at, ${now}),
          'rawText', COALESCE(l.description, ''),
          'fullText', COALESCE(l.description, ''),
          'embeddedData', json_array(),
          'images', json_array(),
          'evidenceStatus', 'historical_backfill'
        )
      ),
      'captured', 'pending', 0, 0, 0, NULL, 0, NULL,
      ${now}, ${now}, NULL
    FROM listings l;

    UPDATE parsing_queue
    SET status = 'cancelled', lease_until = NULL, completed_at = ${now},
        updated_at = ${now}, last_error = 'Superseded by schema v4'
    WHERE schema_version < 4 AND status IN ('pending', 'retry', 'processing');

    DELETE FROM homeserver_models;
    DELETE FROM homeserver_listing_model_scores;
    DELETE FROM homeserver_listing_market_model;
    DELETE FROM homeserver_market_surface_cells;
    DELETE FROM homeserver_model_runs;
    DELETE FROM homeserver_listing_scores;
  `);
}

function addColumn(db, table, definition) {
  const name = definition.split(/\s+/)[0];
  const exists = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((column) => column.name === name);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}
