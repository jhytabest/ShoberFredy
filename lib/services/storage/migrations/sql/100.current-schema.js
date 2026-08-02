/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';

/**
 * The only database definition.
 *
 * Creates the current schema, and reaches it from any older one by discarding
 * the listing corpus rather than converting it. That is a deliberate trade, and
 * it is defensible because of what the corpus is: adverts for flats that were
 * let months ago. Discovery refills it within a day, the LLM re-extracts only
 * what is still on the market, and the market model retrains on its next
 * schedule. What is not discarded is everything that cost money or cannot be
 * re-derived — the geocode cache, the jobs, the settings, the trained models.
 *
 * The alternative was a conversion pass: merge rows that were separate only
 * because two jobs found the same advert, synthesise a per-job verdict for each
 * from a schema that could store one global answer, move never-extracted
 * rejections onto their sources, re-anchor every claim. It worked, and it was
 * five hundred lines of one-shot SQL that would be dead weight the day after it
 * ran, carrying inherited verdicts that were never two of the three jobs' own.
 *
 * The model this creates: a listing is global and exists only once the model has
 * read the advert; what each job decided about it is a `listing_verdicts` row;
 * an advert refused before extraction is a `source_rejections` row and never
 * enters the ledger; and every such subject owns identity claims, which is what
 * stops the same advert being fetched, extracted and refused again on every run.
 *
 * The runner re-applies this file whenever its checksum changes and keeps one
 * ledger row, so up() must stay safe to run again over a database it created.
 * Every step is `IF NOT EXISTS` or guarded by a shape probe.
 */
export function up(db) {
  if (hasStaleShape(db)) discardListingCorpus(db);
  createTables(db);
  addMissingColumns(db);
  createIndexes(db);
  seedSettings(db);
  reconcileWorkOutcomes(db);
  migrateBlacklistToSettings(db);
  migrateAttributeDocuments(db);
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

/**
 * Lift the domain vocabulary out of `status`, and the things that were never
 * errors out of `last_error`.
 *
 * Each statement is self-idempotent: it only touches rows that still carry the
 * old shape, so a second run finds nothing left to do.
 */
function reconcileWorkOutcomes(db) {
  if (!tableExists(db, 'pipeline_work') || !columnExists(db, 'pipeline_work', 'outcome')) return;
  db.exec(`
    UPDATE pipeline_work SET outcome = status, status = 'done'
     WHERE outcome IS NULL AND status IN ('completed', 'inactive', 'sent', 'waiting_model', 'duplicate');

    UPDATE pipeline_work SET outcome = 'failed' WHERE outcome IS NULL AND status = 'dead';
    UPDATE pipeline_work SET outcome = 'cancelled' WHERE outcome IS NULL AND status = 'cancelled';

    -- Parked items were smuggled into 'retry' with a prefix on last_error.
    UPDATE pipeline_work
       SET status = 'deferred', outcome_code = 'transient',
           outcome_note = substr(last_error, 10), last_error = NULL
     WHERE status = 'retry' AND last_error LIKE 'Waiting: %';

    -- Filter verdicts are not errors. The readable truth is in source_rejections.
    UPDATE pipeline_work
       SET outcome = 'filtered', outcome_code = 'filtered', outcome_note = last_error, last_error = NULL
     WHERE status = 'cancelled'
       AND last_error IN ('blacklist', 'spec', 'area', 'intent', 'llm_unextractable', 'no_price', 'no_coordinates');

    -- Policy sentences are not errors either.
    UPDATE pipeline_work SET outcome_note = last_error, last_error = NULL
     WHERE status = 'cancelled' AND last_error IS NOT NULL AND outcome_note IS NULL;
  `);
}

/**
 * Whether this database predates the current model, probed by the columns only
 * the old shape had: a listing that carried its own job and its own verdict.
 * The absence of `listing_verdicts` counts too, so a half-applied run is
 * finished rather than left straddling both shapes.
 */
function hasStaleShape(db) {
  if (!tableExists(db, 'listings')) return false;
  return (
    columnExists(db, 'listings', 'job_id') ||
    columnExists(db, 'listings', 'hidden_reason') ||
    !tableExists(db, 'listing_verdicts')
  );
}

/**
 * Drop everything that describes adverts, and nothing that describes the
 * installation.
 *
 * Foreign keys are suspended for the whole migration (see migrate.js), so this
 * is a plain sweep rather than a dependency-ordered one. Media files on disk are
 * left alone: scheduled maintenance deletes the images no row references, which
 * after this is all of them, and keeping that in one place is worth more than
 * reclaiming the space a few hours sooner.
 */
function discardListingCorpus(db) {
  const keep = new Set([
    'schema_migrations',
    'users',
    'jobs',
    'settings',
    'pipeline_control',
    // How much each provider is currently refusing to talk to us. Discarding it
    // would hand a blocked provider a clean slate and a fresh round of full-price
    // navigations to rediscover the block.
    'provider_breaker_state',
    // The one table here that was paid for per row.
    'homeserver_geocode_cache',
    // Models price listings; they are not made of them, and they retrain anyway.
    'homeserver_models',
    'homeserver_model_runs',
    'homeserver_market_surface_cells',
  ]);
  const doomed = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((row) => row.name)
    .filter((name) => !keep.has(name));
  for (const table of doomed) db.exec(`DROP TABLE IF EXISTS "${table}"`);
  // An index whose table is gone would still collide with the definition below.
  for (const { name } of db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`)
    .all()) {
    db.exec(`DROP INDEX IF EXISTS "${name}"`);
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
      price_type TEXT,
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

/**
 * Blacklist terms stop being a per-job column and become one setting.
 *
 * The union of what the jobs carried, so nothing a job was refusing quietly
 * starts getting through. They had already drifted apart by one term, which is
 * the whole reason for the move; the union is the strictest reading of what was
 * configured, and pruning is an operator decision rather than a migration's.
 */
function migrateBlacklistToSettings(db) {
  if (!tableExists(db, 'jobs') || !columnExists(db, 'jobs', 'blacklist')) return;
  const seen = new Map();
  for (const row of db.prepare(`SELECT blacklist FROM jobs`).all()) {
    let terms;
    try {
      terms = JSON.parse(row.blacklist || '[]');
    } catch {
      terms = [];
    }
    for (const term of Array.isArray(terms) ? terms : []) {
      const text = String(term ?? '').trim();
      if (text && !seen.has(text.toLocaleLowerCase('de-DE'))) seen.set(text.toLocaleLowerCase('de-DE'), text);
    }
  }
  if (seen.size) {
    db.prepare(
      `INSERT INTO settings (id, create_date, user_id, name, value)
       SELECT ?, ?, NULL, 'blacklist', ?
       WHERE NOT EXISTS (SELECT 1 FROM settings WHERE name = 'blacklist' AND user_id IS NULL)`,
    ).run(crypto.randomUUID(), Date.now(), JSON.stringify([...seen.values()]));
  }
  db.exec(`ALTER TABLE jobs DROP COLUMN blacklist`);
}

/**
 * Bring every stored extraction and attribute document onto the current shape.
 *
 * There is no compatibility layer anywhere else, and this is why: the documents
 * are rewritten once, here, so no reader has to know that two shapes ever
 * existed. Dropped fields go; fields that are new and derivable are derived;
 * fields that are new and unrecoverable become null, which is a distinct answer
 * from 'unknown' — null means the extraction predates the field, 'unknown' means
 * the model read the advert and could not tell.
 *
 * `offered_by` is the only field that is genuinely lost: it was optional and
 * absent from roughly 70% of stored documents, and nothing else records who
 * placed an advert. Cold rent is recoverable for about 87% — stated directly, or
 * a Warmmiete with charges to subtract — and null for the rest.
 *
 * Rewriting `llm_json` is what avoids re-buying the corpus: the parse worker
 * re-validates every cached extraction against the live schema and discards it
 * on mismatch, so leaving the old shape in place would have queued a fresh LLM
 * call for every listing.
 */
function migrateAttributeDocuments(db) {
  if (!tableExists(db, 'listing_attributes')) return;

  const DROPPED = [
    'requirements',
    'conflicts',
    'smokingPolicy',
    'minimumLeaseMonths',
    'maximumOccupants',
    'addressComponents',
    'rentInclusions',
    'recurringCosts',
    'oneTimeBuyoutEur',
    'heatingType',
    'energyValueKwh',
    'petsAllowed',
    'sizeSqm',
    'rooms',
  ];
  const DROPPED_LLM = [
    'requirements',
    'conflicts',
    'smoking_policy',
    'minimum_lease_months',
    'maximum_occupants',
    'address_components',
    'energy',
  ];
  const DROPPED_RENT = [
    'included',
    'currency',
    'period',
    'electricity',
    'internet',
    'parking',
    'furniture',
    'other_recurring',
    'one_time_buyout',
  ];
  const AMENITIES = new Set([
    'balcony',
    'terrace',
    'garden',
    'garden_use',
    'elevator',
    'fitted_kitchen',
    'cellar',
    'parking',
    'garage',
    'underground_parking',
    'bathtub',
    'guest_toilet',
    'dishwasher',
    'washing_machine',
    'parquet',
    'underfloor_heating',
    'old_building',
    'new_building',
    'barrier_free',
    'wheelchair_accessible',
    'fireplace',
    'wg_suitable',
  ]);

  // The same rule as coldEquivalentRent in lib/services/market/corpus.js, and it
  // has to be restated rather than imported: a migration runs before the
  // application is wired up, and must not depend on it.
  const coldEquivalent = (a) => {
    if (a.coldRentEur > 0) return { rent: a.coldRentEur, type: 'cold' };
    const warm = a.warmRentEur > 0 ? a.warmRentEur : null;
    if (warm != null && a.serviceChargesEur > 0) {
      const estimate = warm - a.serviceChargesEur - (a.heatingCostsEur > 0 ? a.heatingCostsEur : 0);
      if (estimate > 0 && estimate >= 0.4 * warm) return { rent: estimate, type: 'cold_est' };
    }
    return { rent: warm, type: warm != null ? 'warm' : 'unknown' };
  };

  const rows = db.prepare(`SELECT listing_id, data FROM listing_attributes`).all();
  const updateAttrs = db.prepare(`UPDATE listing_attributes SET data = ? WHERE listing_id = ?`);
  const updatePrice = db.prepare(`UPDATE listings SET price = ? WHERE id = ?`);
  let rewritten = 0;
  let priced = 0;
  let unpriceable = 0;

  db.transaction(() => {
    for (const row of rows) {
      let attrs;
      try {
        attrs = JSON.parse(row.data || '{}');
      } catch {
        continue;
      }
      if (!attrs || typeof attrs !== 'object') continue;

      for (const key of DROPPED) delete attrs[key];
      if (Array.isArray(attrs.amenities)) attrs.amenities = attrs.amenities.filter((name) => AMENITIES.has(name));
      if (Array.isArray(attrs.amenitiesAbsent)) {
        attrs.amenitiesAbsent = attrs.amenitiesAbsent.filter((name) => AMENITIES.has(name));
      }
      // Absent rather than 'unknown': these predate the fields being required.
      if (attrs.offeredBy === 'unknown' || attrs.offeredBy === undefined) attrs.offeredBy = null;
      if (attrs.leaseType === undefined) attrs.leaseType = null;

      const basis = coldEquivalent(attrs);
      attrs.priceType = basis.rent != null ? basis.type : 'unknown';
      if (basis.rent != null) priced += 1;
      else unpriceable += 1;

      updateAttrs.run(JSON.stringify(attrs), row.listing_id);
      updatePrice.run(basis.rent, row.listing_id);
      rewritten += 1;
    }
  })();

  if (tableExists(db, 'listing_extractions')) {
    const extractions = db
      .prepare(`SELECT queue_id, llm_json FROM listing_extractions WHERE llm_json IS NOT NULL`)
      .all();
    const updateLlm = db.prepare(`UPDATE listing_extractions SET llm_json = ? WHERE queue_id = ?`);
    db.transaction(() => {
      for (const row of extractions) {
        let llm;
        try {
          llm = JSON.parse(row.llm_json);
        } catch {
          continue;
        }
        if (!llm || typeof llm !== 'object') continue;
        if (llm.energy && llm.energy_class === undefined) llm.energy_class = llm.energy.class ?? null;
        for (const key of DROPPED_LLM) delete llm[key];
        if (llm.rent && typeof llm.rent === 'object') for (const key of DROPPED_RENT) delete llm.rent[key];
        if (Array.isArray(llm.amenities)) llm.amenities = llm.amenities.filter((a) => AMENITIES.has(a?.name));
        if (llm.lease_type === undefined) llm.lease_type = null;
        if (llm.offered_by === undefined) llm.offered_by = null;
        if (llm.available_until === undefined) llm.available_until = null;
        if (llm.summary === undefined) llm.summary = null;
        if (llm.energy_class === undefined) llm.energy_class = null;
        updateLlm.run(JSON.stringify(llm), row.queue_id);
      }
    })();
  }

  if (columnExists(db, 'listing_attributes', 'schema_version')) {
    db.exec(`ALTER TABLE listing_attributes DROP COLUMN schema_version`);
  }

  // The pre-extraction area filter is gone, but its refusals do not expire on
  // their own: the detail gate trusts any evidence kind the caller cannot offer,
  // so these rows would keep cancelling captures forever.
  if (tableExists(db, 'source_rejections')) {
    db.exec(`DELETE FROM source_rejections WHERE stage = 'detail' AND reason = 'area'`);
  }

  if (rewritten) {
    // eslint-disable-next-line no-console
    console.log(
      `Rewrote ${rewritten} attribute documents; ${priced} carry a cold-equivalent rent, ${unpriceable} do not.`,
    );
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

function columnExists(db, table, column) {
  return Boolean(db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column));
}
