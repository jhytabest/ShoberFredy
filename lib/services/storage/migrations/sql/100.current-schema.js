/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { intentsImpliedByTerms } from '../../../pipeline/listingFilters.js';
import { normalizeMarket } from '../../../../shared/markets.js';

export function up(db) {
  createTables(db);
  // Before createIndexes: the legacy `settings` table allowed one row per
  // (name, user_id), so the unique index on name alone cannot be built until
  // the user-scoped rows are gone.
  dropLegacySurface(db);
  widenToManyCities(db);
  widenBreakerToMarkets(db);
  retirePriceModelState(db);
  createIndexes(db);
  adoptPerJobFilters(db);
  adoptPerJobSchedule(db);
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
      -- to a market key, isolates provider health and listing identity.
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
      -- Geographic city key resolved from the geocoded locality, so it follows
      -- the flat rather than the search that found it.
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

    -- Cadence is per (job, provider), not just per job: two providers on the
    -- same job can be due at different times, and this is what the scheduler
    -- checks due-ness against and persists to, so a restart does not stampede
    -- every pair into running at once.
    CREATE TABLE IF NOT EXISTS job_provider_schedule (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      last_run_at INTEGER,
      PRIMARY KEY (job_id, provider)
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
  `);
}

// The schema above is what a fresh database gets. This is the same shape
// reached from the one-city database that came before it: a job that owned no
// filters of its own, and one model that answered for everywhere.
function widenToManyCities(db) {
  const jobsCityIsNew = !columnExists(db, 'jobs', 'city');
  const listingsMarketIsNew = !columnExists(db, 'listings', 'market');

  for (const [table, column, definition] of [
    ['jobs', 'city', 'TEXT'],
    ['jobs', 'blacklist', `TEXT NOT NULL DEFAULT '[]'`],
    ['jobs', 'intent_filter', `TEXT NOT NULL DEFAULT '[]'`],
    ['listings', 'market', 'TEXT'],
    ['homeserver_geocode_cache', 'locality', 'TEXT'],
  ]) {
    if (!columnExists(db, table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }

  // Names the city the existing rows have always been about. Backfilled only
  // at the moment each column is created — never inferred from NULL on a later
  // run, because a null city/market is a documented steady state (a listing
  // that resolves to no city remains geographically unscoped) and not
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
}

function retirePriceModelState(db) {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO pipeline_work (
       kind, key, payload_json, status, attempt_count, lease_until, next_attempt_at,
       last_error, outcome, outcome_code, outcome_note, defer_count, created_at, updated_at
     )
     SELECT 'notify', work.key,
            json_object(
              'listingId', work.key,
              'jobId', json_extract(work.payload_json, '$.jobId'),
              'provider', json_extract(work.payload_json, '$.provider')
            ),
            'pending', 0, NULL, 0, NULL, NULL, NULL, NULL, 0, work.created_at, @now
     FROM pipeline_work work
     WHERE work.kind = 'rate'
       AND work.status IN ('pending', 'processing', 'retry', 'deferred')
       AND coalesce(json_extract(work.payload_json, '$.notify'), 0) = 1
       AND EXISTS (
         SELECT 1 FROM jobs job
         WHERE job.id = json_extract(work.payload_json, '$.jobId')
       )
       AND EXISTS (
         SELECT 1 FROM listings listing
         WHERE listing.id = work.key AND listing.state = 'active'
       )
       AND EXISTS (
         SELECT 1 FROM listing_verdicts verdict
         WHERE verdict.listing_id = work.key AND verdict.verdict = 'accepted'
       )
       AND NOT EXISTS (
         SELECT 1 FROM listing_verdicts verdict
         WHERE verdict.listing_id = work.key AND verdict.notified_at IS NOT NULL
       )`,
  ).run({ now });

  db.prepare(
    `UPDATE pipeline_work
     SET status = 'cancelled', lease_until = NULL, next_attempt_at = 0, last_error = NULL,
         outcome = 'superseded', outcome_code = 'superseded',
         outcome_note = 'Price-model work retired', updated_at = @now
     WHERE kind IN ('rate', 'market-model')
       AND status IN ('pending', 'processing', 'retry', 'deferred')`,
  ).run({ now });

  db.exec(`
    DROP TABLE IF EXISTS homeserver_listing_model_scores;
    DROP TABLE IF EXISTS homeserver_models;
    DROP TABLE IF EXISTS homeserver_model_runs;
  `);
}

// A provider being blocked in one city said nothing about whether it was
// blocked in another, so the breaker keyed by provider alone paused every
// job on that portal at once. Widening the primary key needs a rebuild; the
// state already on record is the state for the city this deployment has been
// searching all along.
function widenBreakerToMarkets(db) {
  if (!tableExists(db, 'provider_breaker_state') || columnExists(db, 'provider_breaker_state', 'market')) return;
  db.exec(`
    CREATE TABLE provider_breaker_state_rebuilt (
      provider TEXT NOT NULL,
      market TEXT NOT NULL,
      failure_score REAL NOT NULL DEFAULT 0,
      challenge_score REAL NOT NULL DEFAULT 0,
      open_until INTEGER NOT NULL DEFAULT 0,
      last_success_at INTEGER,
      last_signal_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, market)
    );
    INSERT INTO provider_breaker_state_rebuilt
      (provider, market, failure_score, challenge_score, open_until, last_success_at, last_signal_at, updated_at)
      SELECT provider, '${FOUNDING_MARKET}', failure_score, challenge_score, open_until, last_success_at, last_signal_at, updated_at
      FROM provider_breaker_state;
    DROP TABLE provider_breaker_state;
    ALTER TABLE provider_breaker_state_rebuilt RENAME TO provider_breaker_state;
  `);
}

// Every job that existed before jobs had a city searched this one, and every
// listing already stored was found by one of them.
const FOUNDING_MARKET = 'berlin';
const FOUNDING_CITY = 'Berlin';

// The deployment-wide default every job ran on before interval moved onto
// jobs. Only used as a fallback if a database somehow reached this migration
// with no 'interval' setting at all.
const DEFAULT_INTERVAL_MINUTES = 15;

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
// from the era when Fredy shipped a web UI, and a retired spatial-analysis
// table. Written to be re-runnable, because editing this file changes its
// checksum and `up()` runs again against an existing database.
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

  // Settings that only ever fed the web UI or its login sessions. Proxy
  // configuration now comes from FREDY_PROXY_URL.
  db.prepare(
    `DELETE FROM settings WHERE name IN
       ('analyticsEnabled', 'demoMode', 'baseUrl', 'sessionTTL', 'session_secret', 'proxyUrl')`,
  ).run();

  // Completed one-shot repair markers. The passes they guarded are gone.
  if (tableExists(db, 'pipeline_control')) {
    db.prepare(
      `DELETE FROM pipeline_control
       WHERE name LIKE 'backfill\\_%' ESCAPE '\\' OR name = 'repriced_unpriced_listings'`,
    ).run();
  }
}

// Interval, working hours and the notify shape all move from one
// deployment-wide setting onto each job, the same way city and the filters
// did in adoptPerJobFilters. Backfilled only at column creation, for the same
// reason the city/market backfill is: re-deriving it from a later run would
// stamp a job that has since had its own cadence set back to the old default.
function adoptPerJobSchedule(db) {
  const intervalIsNew = !columnExists(db, 'jobs', 'interval');
  const workingHoursIsNew = !columnExists(db, 'jobs', 'working_hours');
  const notifyIsNew = !columnExists(db, 'jobs', 'notify');

  for (const [table, column, definition] of [
    ['jobs', 'interval', 'INTEGER'],
    ['jobs', 'working_hours', 'TEXT'],
    ['jobs', 'notify', 'TEXT'],
  ]) {
    if (!columnExists(db, table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }

  if (intervalIsNew || workingHoursIsNew) {
    const settingValue = (name) => {
      const row = db.prepare(`SELECT value FROM settings WHERE name = ?`).get(name);
      if (!row) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    };
    const interval = Number(settingValue('interval'));
    const workingHours = settingValue('workingHours') || { from: '', to: '' };
    db.prepare(`UPDATE jobs SET interval = COALESCE(interval, ?), working_hours = COALESCE(working_hours, ?)`).run(
      Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_MINUTES,
      JSON.stringify(workingHours),
    );
    db.prepare(`DELETE FROM settings WHERE name IN ('interval', 'workingHours', 'port')`).run();
  }

  if (notifyIsNew) {
    const jobs = db.prepare(`SELECT id, notification_adapter FROM jobs`).all();
    const update = db.prepare(`UPDATE jobs SET notify = ? WHERE id = ?`);
    for (const job of jobs) {
      let adapters;
      try {
        adapters = JSON.parse(job.notification_adapter || '[]');
      } catch {
        adapters = [];
      }
      const telegramFields = (Array.isArray(adapters) ? adapters : []).find(
        (entry) => entry?.id === 'telegram',
      )?.fields;
      update.run(
        JSON.stringify({
          token: telegramFields?.token ?? null,
          chatId: telegramFields?.chatId ?? null,
          threadId: telegramFields?.messageThreadId ?? null,
          plainText: Boolean(telegramFields?.plainText),
        }),
        job.id,
      );
    }
    if (columnExists(db, 'jobs', 'notification_adapter')) {
      db.exec(`ALTER TABLE jobs DROP COLUMN notification_adapter;`);
    }
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

function columnExists(db, table, column) {
  return Boolean(db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column));
}
