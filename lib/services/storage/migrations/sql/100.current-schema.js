/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import { migrateClaims } from '../steps/claims.js';
import { migrateWorkQueue } from '../steps/workQueue.js';
import { migrateAttributesJson } from '../steps/attributesJson.js';
import { migrateSingleUser } from '../steps/singleUser.js';

/**
 * The only database definition.
 *
 * On an empty database it creates the current schema directly. On a database
 * created by an older release it preserves product data, folds duplicated
 * listing text into listing_texts, removes retired backfill/version state, and
 * compacts historical pipeline payloads into metadata.
 */
export function up(db) {
  db.pragma('defer_foreign_keys = ON');
  // The runner re-applies this file whenever its checksum changes and keeps only
  // one ledger row, so up() has to be safe to run again over a database it has
  // already converted. listing_texts is created here and nowhere else, which
  // makes it the marker for "already converted": without that test the rebuild
  // ran a second time and its own output failed the requirement check below,
  // because the first pass had already dropped the legacy columns it reads.
  const legacy = tableExists(db, 'listings') && !tableExists(db, 'listing_texts');

  createCoreTables(db);
  seedSettings(db);
  if (legacy) {
    // The rebuild reads columns introduced right across the 27..39 range —
    // listing_attributes.address_json among them — so the presence of
    // parsing_queue.queue_kind (added in 27) does not prove the source schema
    // can supply them. Gating on queue_kind alone made this migration fail
    // halfway through on a 27..29 database, after createCoreTables had already
    // run. Refusing up front is the only safe answer: there is no partial
    // rebuild that leaves a coherent schema behind, and silently skipping it
    // would leave the old listings shape in place for the application to break
    // on later, further from the cause.
    requireRebuildableSchema(db);
    preserveListingText(db);
    rebuildListings(db);
    rebuildAttributes(db);
    rebuildPipeline(db);
  }
  // Runs unconditionally: retiring a table is idempotent, and doing it outside
  // the legacy branch is what lets this file drop something on a database it has
  // already converted — which is how the market batch table goes away.
  dropRetiredTables(db);

  // Each step below owns one concept and is individually idempotent, so this
  // file stays safe to re-run. Order matters only in that the work queue must
  // exist before the queues it absorbs are dropped, and claims must exist
  // before they are backfilled from the listings they describe.
  migrateSingleUser(db);
  migrateAttributesJson(db);
  migrateWorkQueue(db);
  migrateClaims(db);

  createIndexes(db);
}

/**
 * Every column the rebuild path dereferences that was added after the base v4
 * pipeline landed. Checked together so the error names everything that is
 * missing, rather than surfacing them one failed migration at a time.
 */
const REBUILD_REQUIREMENTS = [
  ['parsing_queue', 'queue_kind'],
  ['listing_attributes', 'address_json'],
  ['listing_attributes', 'summary'],
  ['listing_sources', 'dedupe_keys_json'],
];

function requireRebuildableSchema(db) {
  const missing = REBUILD_REQUIREMENTS.filter(
    ([table, column]) => tableExists(db, table) && !columnExists(db, table, column),
  ).map(([table, column]) => `${table}.${column}`);
  const absentTables = [...new Set(REBUILD_REQUIREMENTS.map(([table]) => table))].filter(
    (table) => !tableExists(db, table),
  );
  if (!missing.length && !absentTables.length) return;
  throw new Error(
    'This database predates the v4 listing pipeline and cannot be rebuilt in place. ' +
      `Missing: ${[...absentTables, ...missing].join(', ')}. ` +
      'Upgrade it with a release that still shipped migrations 29-39 first, or start from an empty database.',
  );
}

function seedSettings(db) {
  const insert = db.prepare(
    `INSERT INTO settings (id, create_date, user_id, name, value)
     SELECT ?, ?, NULL, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM settings WHERE name = ? AND user_id IS NULL
     )`,
  );
  const now = Date.now();
  for (const [name, value] of Object.entries({
    interval: '60',
    port: 9998,
    workingHours: { from: '', to: '' },
    sessionTTL: 2,
  })) {
    insert.run(crypto.randomUUID(), now, name, JSON.stringify(value), name);
  }
}

function createCoreTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      last_login INTEGER,
      is_admin INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      name TEXT,
      blacklist TEXT NOT NULL DEFAULT '[]',
      provider TEXT NOT NULL DEFAULT '[]',
      notification_adapter TEXT NOT NULL DEFAULT '[]',
      spatial_filter TEXT,
      spec_filter TEXT,
      last_run_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      created_at INTEGER,
      hash TEXT,
      provider TEXT,
      job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
      price REAL,
      size REAL,
      rooms REAL,
      title TEXT,
      image_url TEXT,
      address TEXT,
      link TEXT,
      is_active INTEGER DEFAULT 1,
      latitude REAL,
      longitude REAL,
      manually_deleted INTEGER NOT NULL DEFAULT 0,
      status TEXT,
      notes TEXT,
      hidden_reason TEXT,
      inactive_at INTEGER,
      inactive_reason TEXT,
      source_urls_json TEXT NOT NULL DEFAULT '[]',
      filter_reasons_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE(job_id, hash)
    );

    CREATE TABLE IF NOT EXISTS listing_texts (
      listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
      full_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      captured_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      create_date INTEGER NOT NULL,
      user_id TEXT,
      name TEXT NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS homeserver_geocode_cache (
      address_key TEXT PRIMARY KEY,
      source_address TEXT NOT NULL,
      status TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      accuracy TEXT NOT NULL,
      place_id TEXT,
      formatted_address TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS homeserver_model_runs (
      id TEXT PRIMARY KEY,
      model_version TEXT NOT NULL,
      training_rows INTEGER NOT NULL,
      scored_rows INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      metrics_json TEXT NOT NULL,
      model_family TEXT
    );

    CREATE TABLE IF NOT EXISTS homeserver_models (
      family TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      training_rows INTEGER NOT NULL,
      artifact_json TEXT NOT NULL,
      eval_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS homeserver_market_surface_cells (
      cell_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES homeserver_model_runs(id),
      model_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      cell_size_m INTEGER NOT NULL,
      center_latitude REAL NOT NULL,
      center_longitude REAL NOT NULL,
      predicted_price_per_sqm REAL NOT NULL,
      confidence REAL NOT NULL,
      samples_250m INTEGER NOT NULL,
      samples_500m INTEGER NOT NULL,
      samples_1000m INTEGER NOT NULL,
      effective_samples REAL NOT NULL,
      surface_components_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS homeserver_listing_model_scores (
      listing_id TEXT NOT NULL,
      model_family TEXT NOT NULL,
      model_version TEXT NOT NULL,
      scored_at INTEGER NOT NULL,
      model_created_at INTEGER,
      actual_price_per_sqm REAL NOT NULL,
      fair_price_per_sqm REAL NOT NULL,
      fair_lo_price_per_sqm REAL,
      fair_hi_price_per_sqm REAL,
      coverage_level REAL,
      delta_percent REAL NOT NULL,
      comps_500m INTEGER,
      coord_quality TEXT,
      price_type TEXT,
      swap INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (listing_id, model_family)
    );

    CREATE TABLE IF NOT EXISTS listing_images (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      listing_id TEXT REFERENCES listings(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'photo',
      original_url TEXT,
      storage_path TEXT,
      content_hash TEXT,
      mime_type TEXT,
      byte_size INTEGER,
      width INTEGER,
      height INTEGER,
      download_status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      UNIQUE(queue_id, position)
    );

    CREATE TABLE IF NOT EXISTS listing_extractions (
      queue_id TEXT PRIMARY KEY,
      listing_id TEXT REFERENCES listings(id) ON DELETE CASCADE,
      visual_json TEXT,
      llm_json TEXT,
      vision_model TEXT,
      text_model TEXT,
      vision_duration_ms INTEGER,
      llm_duration_ms INTEGER,
      parsed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS llm_call_audit (
      id TEXT PRIMARY KEY,
      queue_id TEXT,
      listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
      operation TEXT NOT NULL,
      model TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      request_bytes INTEGER NOT NULL,
      response_sha256 TEXT,
      response_bytes INTEGER,
      response_headers_json TEXT,
      usage_json TEXT,
      http_status INTEGER,
      outcome TEXT NOT NULL DEFAULT 'started',
      error TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS listing_sources (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_url TEXT NOT NULL,
      detail_queue_id TEXT,
      parsing_queue_id TEXT,
      listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
      representative_source_id TEXT REFERENCES listing_sources(id) ON DELETE SET NULL,
      dedupe_stage TEXT,
      dedupe_keys_json TEXT NOT NULL DEFAULT '[]',
      hidden_reason TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      UNIQUE(job_id, provider, source_key)
    );

    CREATE TABLE IF NOT EXISTS listing_source_observations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES listing_sources(id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK(stage IN ('discovery','detail')),
      content_hash TEXT NOT NULL,
      content_bytes INTEGER NOT NULL DEFAULT 0,
      observed_at INTEGER NOT NULL,
      UNIQUE(source_id, stage, content_hash)
    );

    CREATE TABLE IF NOT EXISTS pipeline_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT REFERENCES listing_sources(id) ON DELETE SET NULL,
      listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
      queue_id TEXT,
      stage TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pipeline_control (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_budget_usage (
      day INTEGER PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );

  `);
}

function preserveListingText(db) {
  db.exec(`
    WITH candidates AS (
      SELECT id AS listing_id, description AS full_text, created_at AS captured_at
      FROM listings WHERE NULLIF(TRIM(description), '') IS NOT NULL
      UNION ALL
      SELECT listing_id, source_text, COALESCE(parsed_at, 0)
      FROM listing_extractions
      WHERE listing_id IS NOT NULL AND NULLIF(TRIM(source_text), '') IS NOT NULL
      UNION ALL
      SELECT listing_id,
             CASE WHEN json_valid(capture_json) THEN json_extract(capture_json, '$.fullText') END,
             updated_at
      FROM parsing_queue WHERE listing_id IS NOT NULL AND json_valid(capture_json)
      UNION ALL
      SELECT s.listing_id,
             CASE WHEN json_valid(q.capture_json) THEN json_extract(q.capture_json, '$.fullText') END,
             q.updated_at
      FROM listing_sources s
      JOIN detail_fetch_queue q ON q.id = s.detail_queue_id
      WHERE s.listing_id IS NOT NULL AND json_valid(q.capture_json)
    ),
    ranked AS (
      SELECT listing_id, TRIM(full_text) AS full_text, captured_at,
             ROW_NUMBER() OVER (
               PARTITION BY listing_id
               ORDER BY LENGTH(TRIM(full_text)) DESC, captured_at DESC
             ) AS rank
      FROM candidates
      WHERE NULLIF(TRIM(full_text), '') IS NOT NULL
    )
    INSERT OR REPLACE INTO listing_texts(listing_id, full_text, content_hash, captured_at)
    SELECT listing_id, full_text, '', COALESCE(captured_at, 0)
    FROM ranked WHERE rank = 1;

    INSERT OR IGNORE INTO listing_texts(listing_id, full_text, content_hash, captured_at)
    SELECT id,
           TRIM(COALESCE(title, '') || char(10) || COALESCE(address, '') || char(10) || COALESCE(link, '')),
           '',
           COALESCE(created_at, 0)
    FROM listings;
  `);
  const update = db.prepare('UPDATE listing_texts SET content_hash = ? WHERE listing_id = ?');
  for (const row of db.prepare('SELECT listing_id, full_text FROM listing_texts').all()) {
    update.run(sha256(row.full_text), row.listing_id);
  }
}

function rebuildListings(db) {
  for (const column of ['description', 'distance_to_destination', 'legacy_snapshot_json', 'canonical_schema_version']) {
    dropColumn(db, 'listings', column);
  }
}

function rebuildAttributes(db) {
  db.exec(`
    ALTER TABLE listing_attributes RENAME TO listing_attributes__old;
  `);
  createCoreTables(db);
  db.exec(`
    INSERT INTO listing_attributes (
      listing_id, cold_rent_eur, warm_rent_eur, service_charges_eur, heating_costs_eur,
      deposit_eur, price_type, rooms, floor, building_year, property_type, energy_class,
      pets_allowed, available_from, swap, features_json, parsed_at, listing_type,
      bedrooms, bathrooms, total_floors, condition, furnished, heating_type,
      energy_value_kwh, amenities_json, availability, comments, address_json,
      availability_precision, available_until, furnishing_status, pets_policy,
      smoking_policy, lease_type, minimum_lease_months, maximum_occupants,
      amenities_absent_json, rent_inclusions_json, requirements_json, conflicts_json,
      recurring_costs_json, one_time_buyout_eur, summary
    )
    SELECT
      listing_id, cold_rent_eur, warm_rent_eur, service_charges_eur, heating_costs_eur,
      deposit_eur, price_type, rooms, floor, building_year, property_type, energy_class,
      pets_allowed, available_from, swap, COALESCE(features_json, '{}'), parsed_at, listing_type,
      bedrooms, bathrooms, total_floors, condition, furnished, heating_type,
      energy_value_kwh, COALESCE(amenities_json, '[]'), availability, comments, address_json,
      availability_precision, available_until, furnishing_status, pets_policy,
      smoking_policy, lease_type, minimum_lease_months, maximum_occupants,
      COALESCE(amenities_absent_json, '[]'), COALESCE(rent_inclusions_json, '[]'),
      COALESCE(requirements_json, '[]'), COALESCE(conflicts_json, '[]'),
      COALESCE(recurring_costs_json, '{}'), one_time_buyout_eur, summary
    FROM listing_attributes__old;
    DROP TABLE listing_attributes__old;
  `);
}

function rebuildPipeline(db) {
  const tables = [
    'parsing_queue',
    'listing_images',
    'listing_extractions',
    'processing_attempts',
    'llm_call_audit',
    'detail_fetch_queue',
    'listing_sources',
    'listing_source_observations',
    'pipeline_audit_events',
    'llm_budget_usage',
  ];
  for (const table of tables) db.exec(`ALTER TABLE ${table} RENAME TO ${table}__old`);

  createCoreTables(db);
  db.exec(`
    CREATE TEMP TABLE queue_map(old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL);
    INSERT INTO queue_map(old_id, new_id)
    WITH live AS (
      SELECT id,
             FIRST_VALUE(id) OVER (
               PARTITION BY job_id, provider,
                 COALESCE(NULLIF(external_id, ''), NULLIF(source_url, ''), source_hash)
               ORDER BY
                 CASE WHEN status IN ('pending','processing','retry') THEN 0 ELSE 1 END,
                 updated_at DESC, id
             ) AS new_id
      FROM parsing_queue__old
      WHERE queue_kind = 'live'
    )
    SELECT id, new_id FROM live;

    INSERT INTO parsing_queue (
      id, job_id, provider, source_key, source_hash, listing_id, external_id,
      source_url, discovered_at, capture_json, stage, status, attempt_count,
      llm_attempt_count, geocode_attempt_count, lease_until, next_attempt_at,
      last_error, created_at, updated_at, completed_at
    )
    SELECT q.id, q.job_id, q.provider,
           COALESCE(NULLIF(q.external_id, ''), NULLIF(q.source_url, ''), q.source_hash),
           q.source_hash, q.listing_id, q.external_id, q.source_url, q.discovered_at,
           CASE WHEN q.status IN ('pending','processing','retry') THEN q.capture_json END,
           q.stage, q.status, q.attempt_count, q.llm_attempt_count, q.geocode_attempt_count,
           q.lease_until, q.next_attempt_at, q.last_error, q.created_at, q.updated_at, q.completed_at
    FROM parsing_queue__old q
    JOIN queue_map m ON m.old_id = q.id AND m.new_id = q.id;

    WITH deduped AS (
      SELECT i.*, m.new_id,
             ROW_NUMBER() OVER (
               PARTITION BY m.new_id, COALESCE(NULLIF(i.content_hash, ''), NULLIF(i.original_url, ''), i.id)
               ORDER BY CASE WHEN i.download_status = 'stored' THEN 0 ELSE 1 END, i.position, i.id
             ) AS keep
      FROM listing_images__old i JOIN queue_map m ON m.old_id = i.queue_id
    ),
    positioned AS (
      SELECT *,
             ROW_NUMBER() OVER (PARTITION BY new_id ORDER BY position, id) - 1 AS new_position
      FROM deduped WHERE keep = 1
    )
    INSERT INTO listing_images (
      id, queue_id, listing_id, position, kind, original_url, storage_path,
      content_hash, mime_type, byte_size, width, height, download_status, error
    )
    SELECT id, new_id, listing_id, new_position, kind, original_url, storage_path,
           content_hash, mime_type, byte_size, width, height, download_status, error
    FROM positioned;

    WITH ranked AS (
      SELECT e.*, m.new_id,
             ROW_NUMBER() OVER (
               PARTITION BY m.new_id
               ORDER BY CASE WHEN e.llm_json IS NOT NULL THEN 0 ELSE 1 END,
                        COALESCE(e.parsed_at, 0) DESC, e.rowid DESC
             ) AS rank
      FROM listing_extractions__old e JOIN queue_map m ON m.old_id = e.queue_id
    )
    INSERT INTO listing_extractions (
      queue_id, listing_id, visual_json, llm_json, vision_model, text_model,
      vision_duration_ms, llm_duration_ms, parsed_at
    )
    SELECT new_id, listing_id, visual_json, llm_json, vision_model, text_model,
           vision_duration_ms, llm_duration_ms, parsed_at
    FROM ranked WHERE rank = 1;

    INSERT INTO processing_attempts(queue_id, started_at, status)
    SELECT m.new_id, a.started_at,
           CASE WHEN a.status = 'started' THEN 'interrupted' ELSE a.status END
    FROM processing_attempts__old a
    JOIN queue_map m ON m.old_id = a.queue_id;

    INSERT INTO detail_fetch_queue (
      id, job_id, provider, source_key, external_id, source_url, discovery_json,
      discovery_hash, capture_json, status, attempt_count, lease_until,
      next_attempt_at, last_error, capture_queue_id, created_at, updated_at, completed_at
    )
    SELECT d.id, d.job_id, d.provider, d.source_key, d.external_id, d.source_url,
           CASE WHEN d.status IN ('pending','processing','retry') THEN d.discovery_json END,
           d.discovery_hash,
           CASE WHEN d.status IN ('pending','processing','retry') THEN d.capture_json END,
           d.status, d.attempt_count, d.lease_until, d.next_attempt_at, d.last_error,
           m.new_id, d.created_at, d.updated_at, d.completed_at
    FROM detail_fetch_queue__old d
    LEFT JOIN queue_map m ON m.old_id = d.capture_queue_id;

    INSERT INTO listing_sources (
      id, job_id, provider, source_key, source_url, detail_queue_id,
      parsing_queue_id, listing_id, representative_source_id, dedupe_stage,
      dedupe_keys_json, hidden_reason, first_seen_at, last_seen_at
    )
    SELECT s.id, s.job_id, s.provider, s.source_key, s.source_url, s.detail_queue_id,
           m.new_id, s.listing_id, s.representative_source_id, s.dedupe_stage,
           COALESCE(s.dedupe_keys_json, '[]'),
           COALESCE(s.post_llm_hidden_reason, s.pre_llm_hidden_reason),
           s.first_seen_at, s.last_seen_at
    FROM listing_sources__old s
    LEFT JOIN queue_map m ON m.old_id = s.parsing_queue_id;

    INSERT INTO listing_source_observations (
      id, source_id, stage, content_hash, content_bytes, observed_at
    )
    SELECT id, source_id, stage, content_hash, LENGTH(CAST(payload_json AS BLOB)), observed_at
    FROM listing_source_observations__old;

    INSERT INTO pipeline_audit_events (
      id, source_id, listing_id, queue_id, stage, action, reason, payload_json, created_at
    )
    SELECT id, source_id, listing_id, COALESCE(m.new_id, a.queue_id),
           stage, action, reason, payload_json, created_at
    FROM pipeline_audit_events__old a
    LEFT JOIN queue_map m ON m.old_id = a.queue_id;

    INSERT INTO llm_budget_usage(day, count)
    SELECT day, SUM(count) FROM llm_budget_usage__old GROUP BY day;

    DELETE FROM pipeline_control
    WHERE name IN ('backfill_paused', 'parser_backfill_credit');
  `);

  copyLlmAuditDigests(db);

  db.exec(`
    DROP TABLE pipeline_audit_events__old;
    DROP TABLE listing_source_observations__old;
    DROP TABLE listing_sources__old;
    DROP TABLE detail_fetch_queue__old;
    DROP TABLE listing_images__old;
    DROP TABLE listing_extractions__old;
    DROP TABLE processing_attempts__old;
    DROP TABLE llm_call_audit__old;
    DROP TABLE llm_budget_usage__old;
    DROP TABLE parsing_queue__old;
    DROP TABLE queue_map;
  `);
}

function copyLlmAuditDigests(db) {
  const insert = db.prepare(
    `INSERT INTO llm_call_audit (
       id, queue_id, listing_id, operation, model, tool_name,
       request_sha256, request_bytes, response_sha256, response_bytes,
       response_headers_json, usage_json, http_status, outcome, error,
       started_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const map = db.prepare('SELECT new_id FROM queue_map WHERE old_id = ?');
  const selectPage = db.prepare(
    'SELECT rowid AS source_rowid, * FROM llm_call_audit__old WHERE rowid > ? ORDER BY rowid LIMIT 250',
  );
  let sourceRowId = 0;
  while (true) {
    const rows = selectPage.all(sourceRowId);
    if (!rows.length) break;
    for (const row of rows) {
      const request = row.request_json || '';
      const response = row.response_body || '';
      insert.run(
        row.id,
        row.queue_id ? (map.get(row.queue_id)?.new_id ?? null) : null,
        row.listing_id,
        row.operation,
        row.model,
        row.tool_name,
        sha256(request),
        Buffer.byteLength(request),
        response ? sha256(response) : null,
        response ? Buffer.byteLength(response) : null,
        row.response_headers_json,
        row.usage_json,
        row.http_status,
        row.outcome,
        row.error,
        row.started_at,
        row.completed_at,
      );
    }
    sourceRowId = rows.at(-1).source_rowid;
  }
}

function dropRetiredTables(db) {
  db.exec(`
    DROP TABLE IF EXISTS homeserver_listing_scores;
    -- 33 denormalised columns per listing per model family, rewritten nightly,
    -- with the Prometheus exporter as its only reader and ten columns that had
    -- none. The exporter now reads homeserver_listing_model_scores, which the
    -- API, UI and notification path already use.
    DROP TABLE IF EXISTS homeserver_listing_market_model;
    DROP TABLE IF EXISTS pre_llm_archive_listings;
    DROP TABLE IF EXISTS pre_llm_archive_runs;
    DROP TABLE IF EXISTS canonical_merge_archive;
    DROP TABLE IF EXISTS watch_list;
    DROP TABLE IF EXISTS debug_logs;
  `);
}

function createIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at ON schema_migrations(applied_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_enabled ON jobs(enabled);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_name_user_id
      ON settings(name, IFNULL(user_id, 'GLOBAL_SETTING'));
    CREATE INDEX IF NOT EXISTS idx_listings_created_at ON listings(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_listings_coordinates ON listings(latitude, longitude);
    CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(json_extract(status, '$.status'));
    CREATE INDEX IF NOT EXISTS idx_listing_texts_hash ON listing_texts(content_hash);
    CREATE INDEX IF NOT EXISTS idx_listing_images_listing ON listing_images(listing_id, position);
    CREATE INDEX IF NOT EXISTS idx_listing_images_hash ON listing_images(content_hash);
    CREATE INDEX IF NOT EXISTS idx_listing_extractions_listing ON listing_extractions(listing_id);
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_queue ON llm_call_audit(queue_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_listing ON llm_call_audit(listing_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_outcome ON llm_call_audit(outcome, started_at);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_url ON listing_sources(job_id, source_url);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_detail ON listing_sources(detail_queue_id);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_parsing ON listing_sources(parsing_queue_id);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_listing ON listing_sources(listing_id);
    CREATE INDEX IF NOT EXISTS idx_listing_source_observations_source
      ON listing_source_observations(source_id, stage, observed_at);
    CREATE INDEX IF NOT EXISTS idx_pipeline_audit_source ON pipeline_audit_events(source_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pipeline_audit_listing ON pipeline_audit_events(listing_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_homeserver_market_surface_cells_confidence
      ON homeserver_market_surface_cells(confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_homeserver_model_runs_created_at
      ON homeserver_model_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_homeserver_listing_model_scores_family
      ON homeserver_listing_model_scores(model_family, scored_at DESC);
  `);
}

function dropColumn(db, table, column) {
  if (columnExists(db, table, column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnExists(db, table, column) {
  return Boolean(db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column));
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}
