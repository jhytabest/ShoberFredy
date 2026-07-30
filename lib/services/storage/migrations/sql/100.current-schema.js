/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';

/**
 * The only database definition.
 *
 * Creates the current schema and nothing else. There is deliberately no
 * conversion path from an older release: the upgrade steps that rebuilt
 * pre-refactor databases (single-user collapse, attributes JSON, work queue,
 * claims) ran once, are recorded in git history, and afterwards executed as
 * ~820 lines of no-op on every start. Reaching this schema from an older one
 * means restoring a backup with the release that still carried them.
 *
 * The runner re-applies this file whenever its checksum changes and keeps only
 * one ledger row, so up() stays safe to run again over a database it already
 * created.
 */
export function up(db) {
  db.pragma('defer_foreign_keys = ON');
  createCoreTables(db);
  seedSettings(db);
  dropRetiredColumns(db);
  createIndexes(db);
}

/**
 * Columns whose feature has been removed. Idempotent, and the reason this file
 * still needs to touch an existing database at all: dropping the feature's code
 * and its CREATE TABLE definition would otherwise leave the columns behind on
 * any database that already has them.
 */
function dropRetiredColumns(db) {
  // Supplemental image analysis, removed entirely.
  for (const column of ['visual_json', 'vision_model', 'vision_duration_ms']) {
    dropColumn(db, 'listing_extractions', column);
  }
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
    // Discovery cadence in minutes. Hourly meant a flat posted at 12:01 was not
    // seen until the 13:20 run, which in Berlin decides whether the viewing slot
    // still exists. Polling more often does not cost meaningfully more LLM
    // budget — the number of distinct new adverts per day is set by the market,
    // and re-sightings are absorbed by dedupe — it just finds them sooner.
    interval: '15',
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
      llm_json TEXT,
      text_model TEXT,
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

function columnExists(db, table, column) {
  return Boolean(db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column));
}
