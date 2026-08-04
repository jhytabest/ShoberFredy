/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';

/**
 * The only database definition, and nothing else.
 *
 * It used to carry seven one-time passes as well — a work-outcome reconciliation,
 * a blacklist move, an attribute rewrite, a score discard, an extraction requeue,
 * and a corpus discard for pre-verdict schemas. All of them had run, none of them
 * could ever be retired (the runner permits exactly one migration file, so there
 * is nowhere for finished work to go), and the file that defines the current
 * schema had become a log of every past one. They are gone. Upkeep that runs once
 * now lives in `maintenance/historicalBackfill.js`, which is written to be
 * deleted.
 *
 * One of them was actively unsafe: the score discard was unguarded, so every
 * checksum change wiped every stored market score — including any that had just
 * been backfilled.
 *
 * The model this creates: a listing is global and exists only once the model has
 * read the advert; what each job decided about it is a `listing_verdicts` row;
 * an advert refused before extraction is a `source_rejections` row and never
 * enters the ledger; and every such subject owns identity claims, which is what
 * stops the same advert being fetched, extracted and refused again on every run.
 *
 * The runner re-applies this file whenever its checksum changes and keeps one
 * ledger row, so up() must stay safe to run again over a database it created.
 * Every step is `IF NOT EXISTS` or guarded by a column probe.
 */
export function up(db) {
  createTables(db);
  addMissingColumns(db);
  createIndexes(db);
  seedSettings(db);
}

/**
 * Columns added to tables that already exist. `CREATE TABLE IF NOT EXISTS` does
 * nothing for a database that already has the table, so every column added after
 * the first release has to arrive this way.
 */
function addMissingColumns(db) {
  const additions = [
    ['pipeline_work', 'outcome', 'TEXT'],
    ['pipeline_work', 'outcome_code', 'TEXT'],
    ['pipeline_work', 'outcome_note', 'TEXT'],
    ['pipeline_work', 'defer_count', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [table, column, type] of additions) {
    if (tableExists(db, table) && !columnExists(db, table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

function createTables(db) {
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
      -- No blacklist column: the terms are one deployment-wide setting, because
      -- three jobs meant three lists that agreed only by hand.
      provider TEXT NOT NULL DEFAULT '[]',
      notification_adapter TEXT NOT NULL DEFAULT '[]',
      spatial_filter TEXT,
      spec_filter TEXT,
      last_run_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      create_date INTEGER NOT NULL,
      user_id TEXT,
      name TEXT NOT NULL,
      value TEXT NOT NULL
    );

    -- Facts the model extracted, and nothing else. What a job decided about them
    -- is a verdict; whether the advert is still offered is 'state'.
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      created_at INTEGER,
      last_seen_at INTEGER,
      provider TEXT,
      price REAL,
      size REAL,
      rooms REAL,
      title TEXT,
      image_url TEXT,
      address TEXT,
      link TEXT,
      latitude REAL,
      longitude REAL,
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'gone')),
      state_reason TEXT,
      state_at INTEGER
    );

    -- One row per (listing, job). The config hash and the evidence pair are what
    -- let a later stage ask "already decided, under this configuration, on
    -- evidence that has not moved?" without re-deriving the answer.
    CREATE TABLE IF NOT EXISTS listing_verdicts (
      listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL CHECK (verdict IN ('accepted', 'rejected')),
      reason TEXT,
      stage TEXT NOT NULL CHECK (stage IN ('discovery', 'detail', 'extraction')),
      config_hash TEXT,
      evidence_kind TEXT NOT NULL DEFAULT 'final' CHECK (evidence_kind IN ('card', 'geo', 'final')),
      evidence_hash TEXT,
      decided_at INTEGER NOT NULL,
      notified_at INTEGER,
      CHECK ((verdict = 'rejected') = (reason IS NOT NULL)),
      PRIMARY KEY (listing_id, job_id)
    ) WITHOUT ROWID;

    -- An advert refused before extraction. Not a listing: there are no canonical
    -- facts behind it, only the card that was refused. Deliberately no job_id —
    -- listing_sources.job_id already scopes it, and deleting a job cascades
    -- through that column for free.
    CREATE TABLE IF NOT EXISTS source_rejections (
      source_id TEXT PRIMARY KEY REFERENCES listing_sources(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('discovery', 'detail')),
      config_hash TEXT NOT NULL,
      evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('card', 'geo')),
      evidence_hash TEXT,
      capture_hash TEXT,
      decided_at INTEGER NOT NULL,
      decided_count INTEGER NOT NULL DEFAULT 1,
      last_seen_at INTEGER NOT NULL
    ) WITHOUT ROWID;

    -- A claim is owned by exactly one subject, and a rejection is a subject too.
    -- The claim string stays the primary key because "one claim, one owner" is
    -- what makes a claim an answer rather than a list of candidates.
    CREATE TABLE IF NOT EXISTS listing_claims (
      claim TEXT PRIMARY KEY,
      listing_id TEXT REFERENCES listings(id) ON DELETE CASCADE,
      source_id TEXT REFERENCES listing_sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      CHECK ((listing_id IS NULL) <> (source_id IS NULL))
    );

    CREATE TABLE IF NOT EXISTS listing_texts (
      listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
      full_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      captured_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listing_attributes (
      listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
      data TEXT NOT NULL DEFAULT '{}',
      schema_version INTEGER NOT NULL DEFAULT 4,
      parsed_at INTEGER
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
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      UNIQUE(job_id, provider, source_key)
    );

    CREATE TABLE IF NOT EXISTS listing_source_observations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES listing_sources(id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK(stage IN ('discovery', 'detail')),
      content_hash TEXT NOT NULL,
      content_bytes INTEGER NOT NULL DEFAULT 0,
      observed_at INTEGER NOT NULL,
      UNIQUE(source_id, stage, content_hash)
    );

    CREATE TABLE IF NOT EXISTS pipeline_work (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      -- An exception message, and nothing else. Filter reason codes, policy
      -- sentences and "Waiting: ..." notices used to land here too, which made a
      -- queue of healthy refusals read as a queue of errors.
      last_error TEXT,
      -- What became of the item, split out of status so that column can carry
      -- the lifecycle alone. See lib/services/pipeline/workOutcome.js.
      outcome TEXT,
      outcome_code TEXT,
      outcome_note TEXT,
      -- Parks are bounded: an item waiting on a resource that never arrives is
      -- abandoned rather than re-parked on a timer forever.
      defer_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
    );

    CREATE TABLE IF NOT EXISTS provider_breaker_state (
      provider TEXT PRIMARY KEY,
      -- REAL because the scores decay continuously, computed on read from the
      -- time since the last signal rather than by a background sweep.
      failure_score REAL NOT NULL DEFAULT 0,
      challenge_score REAL NOT NULL DEFAULT 0,
      open_until INTEGER NOT NULL DEFAULT 0,
      last_success_at INTEGER,
      last_signal_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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

    CREATE TABLE IF NOT EXISTS llm_budget_usage (
      day INTEGER PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
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
      listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
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
      swap INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (listing_id, model_family)
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
    CREATE INDEX IF NOT EXISTS idx_listings_link ON listings(link);
    CREATE INDEX IF NOT EXISTS idx_listing_verdicts_job ON listing_verdicts(job_id, verdict, decided_at DESC);
    CREATE INDEX IF NOT EXISTS idx_listing_verdicts_accepted ON listing_verdicts(listing_id) WHERE verdict = 'accepted';
    CREATE INDEX IF NOT EXISTS idx_source_rejections_reason ON source_rejections(reason, decided_at DESC);
    CREATE INDEX IF NOT EXISTS idx_listing_claims_listing ON listing_claims(listing_id);
    CREATE INDEX IF NOT EXISTS idx_listing_claims_source ON listing_claims(source_id);
    CREATE INDEX IF NOT EXISTS idx_listing_texts_hash ON listing_texts(content_hash);
    CREATE INDEX IF NOT EXISTS idx_listing_images_listing ON listing_images(listing_id, position);
    CREATE INDEX IF NOT EXISTS idx_listing_images_hash ON listing_images(content_hash);
    CREATE INDEX IF NOT EXISTS idx_listing_extractions_listing ON listing_extractions(listing_id);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_url ON listing_sources(job_id, source_url);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_detail ON listing_sources(detail_queue_id);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_parsing ON listing_sources(parsing_queue_id);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_listing ON listing_sources(listing_id);
    CREATE INDEX IF NOT EXISTS idx_listing_source_observations_source
      ON listing_source_observations(source_id, stage, observed_at);
    CREATE INDEX IF NOT EXISTS idx_pipeline_work_claim ON pipeline_work(kind, status, next_attempt_at, lease_until);
    CREATE INDEX IF NOT EXISTS idx_pipeline_audit_source ON pipeline_audit_events(source_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pipeline_audit_listing ON pipeline_audit_events(listing_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_queue ON llm_call_audit(queue_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_listing ON llm_call_audit(listing_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_outcome ON llm_call_audit(outcome, started_at);
    CREATE INDEX IF NOT EXISTS idx_homeserver_market_surface_cells_confidence
      ON homeserver_market_surface_cells(confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_homeserver_model_runs_created_at ON homeserver_model_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_homeserver_listing_model_scores_family
      ON homeserver_listing_model_scores(model_family, scored_at DESC);
  `);
}

function seedSettings(db) {
  const insert = db.prepare(
    `INSERT INTO settings (id, create_date, user_id, name, value)
     SELECT ?, ?, NULL, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM settings WHERE name = ? AND user_id IS NULL)`,
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

function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

function columnExists(db, table, column) {
  return Boolean(db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column));
}
