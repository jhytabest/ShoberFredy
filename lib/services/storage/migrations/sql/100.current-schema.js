/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import { intentsImpliedByTerms } from '../../../pipeline/listingFilters.js';
import { normalizeMarket } from '../../../market/markets.js';

export function up(db) {
  createTables(db);
  // Before createIndexes: the legacy `settings` table allowed one row per
  // (name, user_id), so the unique index on name alone cannot be built until
  // the user-scoped rows are gone.
  dropLegacySurface(db);
  widenToManyCities(db);
  createIndexes(db);
  seedSettings(db);
  adoptPerJobFilters(db);
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

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      name TEXT,
      -- The city this job searches. It anchors geocoding fallbacks and, folded
      -- to a market key, decides which price model the job's listings meet.
      city TEXT,
      -- Free text refused over what a card states, before anything is fetched.
      -- Per job, because the terms were one deployment-wide list only while
      -- every job wanted the same thing; a WG search and a flat search do not.
      blacklist TEXT NOT NULL DEFAULT '[]',
      -- What the job refuses once the model has read the advert, as codes from
      -- a closed vocabulary rather than words guessed at from the page.
      intent_filter TEXT NOT NULL DEFAULT '[]',
      provider TEXT NOT NULL DEFAULT '[]',
      notification_adapter TEXT NOT NULL DEFAULT '[]',
      spatial_filter TEXT,
      spec_filter TEXT,
      last_run_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      create_date INTEGER NOT NULL,
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
      -- Which city's market prices this advert. Resolved from the geocoded
      -- locality, so it follows the flat rather than the search that found it.
      market TEXT,
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
      reason_term TEXT,
      stage TEXT NOT NULL CHECK (stage IN ('discovery', 'detail', 'extraction')),
      config_hash TEXT,
      evidence_kind TEXT NOT NULL DEFAULT 'final' CHECK (evidence_kind IN ('card', 'final')),
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
      reason_term TEXT,
      stage TEXT NOT NULL CHECK (stage IN ('discovery', 'detail')),
      config_hash TEXT NOT NULL,
      evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('card')),
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
      -- The city Google put the address in, kept so a listing's market is read
      -- off the geocode rather than guessed at from the address text again.
      locality TEXT,
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
      model_family TEXT,
      market TEXT
    );

    CREATE TABLE IF NOT EXISTS homeserver_models (
      family TEXT NOT NULL,
      market TEXT NOT NULL,
      run_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      training_rows INTEGER NOT NULL,
      artifact_json TEXT NOT NULL,
      eval_json TEXT NOT NULL,
      PRIMARY KEY (family, market)
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
    CREATE INDEX IF NOT EXISTS idx_jobs_enabled ON jobs(enabled);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_name ON settings(name);
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
    CREATE INDEX IF NOT EXISTS idx_homeserver_model_runs_created_at ON homeserver_model_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_homeserver_listing_model_scores_family
      ON homeserver_listing_model_scores(model_family, scored_at DESC);
  `);
}

// The schema above is what a fresh database gets. This is the same shape
// reached from the one-city database that came before it: a job that owned no
// filters of its own, and one model that answered for everywhere.
function widenToManyCities(db) {
  const jobsCityIsNew = !columnExists(db, 'jobs', 'city');
  const listingsMarketIsNew = !columnExists(db, 'listings', 'market');
  const modelRunsMarketIsNew = !columnExists(db, 'homeserver_model_runs', 'market');

  for (const [table, column, definition] of [
    ['jobs', 'city', 'TEXT'],
    ['jobs', 'blacklist', `TEXT NOT NULL DEFAULT '[]'`],
    ['jobs', 'intent_filter', `TEXT NOT NULL DEFAULT '[]'`],
    ['listings', 'market', 'TEXT'],
    ['homeserver_geocode_cache', 'locality', 'TEXT'],
    ['homeserver_model_runs', 'market', 'TEXT'],
  ]) {
    if (!columnExists(db, table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }

  // Names the city the existing rows have always been about. Backfilled only
  // at the moment each column is created — never inferred from NULL on a later
  // run, because a null city/market is a documented steady state (a listing
  // that resolves to no city is left out of every corpus on purpose) and not
  // an unmigrated row. Doing it here, in the same guard as the ALTER TABLE,
  // makes the backfill structurally one-time instead of re-derived from state
  // that legitimately stays NULL forever.
  if (jobsCityIsNew) {
    db.prepare(`UPDATE jobs SET city = ? WHERE city IS NULL OR trim(city) = ''`).run(FOUNDING_CITY);
  }
  if (listingsMarketIsNew) {
    db.prepare(`UPDATE listings SET market = ? WHERE market IS NULL OR trim(market) = ''`).run(
      normalizeMarket(FOUNDING_CITY),
    );
  }
  if (modelRunsMarketIsNew) {
    db.prepare(`UPDATE homeserver_model_runs SET market = ? WHERE market IS NULL`).run(normalizeMarket(FOUNDING_CITY));
  }

  // One model per family became one model per family and market, which moves
  // the primary key. SQLite cannot widen a primary key in place, so the table
  // is rebuilt; the artifact already in it is the model for the city this
  // deployment has been searching all along.
  if (!columnExists(db, 'homeserver_models', 'market')) {
    db.exec(`
      CREATE TABLE homeserver_models_rebuilt (
        family TEXT NOT NULL,
        market TEXT NOT NULL,
        run_id TEXT NOT NULL,
        model_version TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        training_rows INTEGER NOT NULL,
        artifact_json TEXT NOT NULL,
        eval_json TEXT NOT NULL,
        PRIMARY KEY (family, market)
      );
      INSERT INTO homeserver_models_rebuilt
        (family, market, run_id, model_version, created_at, training_rows, artifact_json, eval_json)
        SELECT family, '${FOUNDING_MARKET}', run_id, model_version, created_at, training_rows, artifact_json, eval_json
        FROM homeserver_models;
      DROP TABLE homeserver_models;
      ALTER TABLE homeserver_models_rebuilt RENAME TO homeserver_models;
    `);
  }
}

// Every job that existed before jobs had a city searched this one, and every
// listing already stored was found by one of them.
const FOUNDING_MARKET = 'berlin';
const FOUNDING_CITY = 'Berlin';

// Hands each job the filters it used to borrow. The deployment-wide blacklist
// is copied verbatim onto every job, and the intents it used to imply are
// written out as the codes they always stood for, so the jobs that exist keep
// deciding exactly what they decided yesterday.
function adoptPerJobFilters(db) {
  const settingRow = db.prepare(`SELECT value FROM settings WHERE name = 'blacklist'`).get();
  if (!settingRow) return;

  let terms;
  try {
    terms = JSON.parse(settingRow.value);
  } catch {
    terms = [];
  }
  if (!Array.isArray(terms)) terms = [];

  const inherited = db.prepare(`SELECT id FROM jobs WHERE blacklist = '[]' AND intent_filter = '[]'`).all();
  const update = db.prepare(`UPDATE jobs SET blacklist = @blacklist, intent_filter = @intents WHERE id = @id`);
  const blacklist = JSON.stringify(terms);
  const intents = JSON.stringify(intentsImpliedByTerms(terms));
  for (const job of inherited) update.run({ id: job.id, blacklist, intents });

  db.prepare(`DELETE FROM settings WHERE name = 'blacklist'`).run();
}

// Removes the surface this deployment no longer has: the login/session tables
// from the era when Fredy shipped a web UI, and the market surface-cell table
// that the ridge field replaced. Written to be re-runnable, because editing this
// file changes its checksum and `up()` runs again against an existing database.
function dropLegacySurface(db) {
  if (columnExists(db, 'jobs', 'user_id')) {
    // SQLite cannot drop a column carrying a foreign key, so the table is
    // rebuilt. Migrations run with foreign_keys=OFF inside one transaction.
    db.exec(`
      CREATE TABLE jobs_rebuilt (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        name TEXT,
        provider TEXT NOT NULL DEFAULT '[]',
        notification_adapter TEXT NOT NULL DEFAULT '[]',
        spatial_filter TEXT,
        spec_filter TEXT,
        last_run_at INTEGER
      );
      INSERT INTO jobs_rebuilt (id, enabled, name, provider, notification_adapter, spatial_filter, spec_filter, last_run_at)
        SELECT id, enabled, name, provider, notification_adapter, spatial_filter, spec_filter, last_run_at FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_rebuilt RENAME TO jobs;
      CREATE INDEX IF NOT EXISTS idx_jobs_enabled ON jobs(enabled);
    `);
  }

  if (columnExists(db, 'settings', 'user_id')) {
    // User-scoped rows are all UI state (view mode, dismissed news, deletion
    // prompt). Only the deployment-wide rows survive the column going away.
    db.exec(`
      DELETE FROM settings WHERE user_id IS NOT NULL;
      DROP INDEX IF EXISTS idx_settings_name_user_id;
      ALTER TABLE settings DROP COLUMN user_id;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_name ON settings(name);
    `);
  }

  db.exec(`DROP TABLE IF EXISTS users;`);
  db.exec(`DROP TABLE IF EXISTS homeserver_market_surface_cells;`);

  // Settings that only ever fed the web UI or its login sessions.
  db.prepare(
    `DELETE FROM settings WHERE name IN
       ('analyticsEnabled', 'demoMode', 'baseUrl', 'sessionTTL', 'session_secret')`,
  ).run();

  // Completed one-shot repair markers. The passes they guarded are gone.
  if (tableExists(db, 'pipeline_control')) {
    db.prepare(
      `DELETE FROM pipeline_control
       WHERE name LIKE 'backfill\\_%' ESCAPE '\\' OR name = 'repriced_unpriced_listings'`,
    ).run();
  }
}

function seedSettings(db) {
  const insert = db.prepare(
    `INSERT INTO settings (id, create_date, name, value)
     SELECT ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM settings WHERE name = ?)`,
  );
  const now = Date.now();
  for (const [name, value] of Object.entries({
    interval: '15',
    port: 9998,
    workingHours: { from: '', to: '' },
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
