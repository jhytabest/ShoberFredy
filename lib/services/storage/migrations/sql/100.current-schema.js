/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';

/**
 * The only database definition.
 *
 * Creates the current schema, and converts the one shape that preceded it: the
 * release where a listing carried its own verdict. That conversion is not a
 * general upgrade path — reaching this file from anything older still means
 * restoring a backup with the release that carried the steps — but it cannot be
 * a backup restore either, because the data being reshaped is the production
 * corpus the market models are trained on.
 *
 * What changed, and why the conversion has to exist:
 *
 *   A listing is global. A verdict is not. `listings` carried one `job_id` and
 *   one `hidden_reason`, so whichever job parsed an advert first wrote the
 *   verdict for all of them; the others recovered only by un-hiding the row and
 *   notifying again. Three jobs that differ only in their polygons therefore
 *   paid three detail fetches and three LLM calls per advert to reach a verdict
 *   the schema could only store once. `listing_verdicts` gives each job its own
 *   answer over one shared extraction.
 *
 *   A rejection is not a listing. `markPreLlmHidden` wrote a full `listings` row
 *   — plus its captured page text — for an advert rejected on a search card
 *   without a single HTTP request, so 10,748 rows held 1,382 extractions and the
 *   ledger became 87% adverts nobody had spent anything on. `source_rejections`
 *   keeps the verdict and the identity claims that stop it being re-decided, and
 *   nothing else.
 *
 * The runner re-applies this file whenever its checksum changes and keeps only
 * one ledger row, so up() stays safe to run again over a database it already
 * created. Every step below is either `IF NOT EXISTS`, guarded by a shape probe,
 * or gated on the legacy columns this run removes at the end.
 */
export function up(db) {
  db.pragma('defer_foreign_keys = ON');

  // Probed before anything else runs. `createCoreTables` is CREATE ... IF NOT
  // EXISTS and so cannot change an existing `listings`, and the conversion below
  // reads columns that `dropRetiredColumns` removes at the end of this same run
  // — which is exactly what makes the second run a no-op.
  const legacy = columnExists(db, 'listings', 'hidden_reason');

  createCoreTables(db);
  seedSettings(db);
  reshapeListingClaims(db);
  reshapeModelScores(db);

  if (legacy) {
    convertLegacyListings(db);
    dropRetiredIndexes(db);
    rebuildListings(db);
  }

  dropRetiredColumns(db);
  createIndexes(db);
  recordSchemaShape(db);
  assertReferentialIntegrity(db);
}

/**
 * Reshape `listings` into the current form.
 *
 * A rebuild rather than a series of DROP COLUMNs, for two reasons. The column
 * that has to go carries a table-level `FOREIGN KEY (job_id) REFERENCES jobs`,
 * and SQLite refuses to drop a column named in one — the inline `REFERENCES`
 * form the schema file has used since is droppable, the older table-level form
 * this database was actually created with is not. And the same database has
 * `price INTEGER`, `size INTEGER` and `status JSON` where the declaration says
 * REAL and TEXT, so a rebuild is the only thing that makes the stored shape and
 * the declared shape agree.
 *
 * Create, copy, drop, rename — never rename-then-drop. Renaming `listings` first
 * rewrites the REFERENCES clause of every child to name the temporary copy, and
 * dropping that copy then takes the children with it. Foreign keys are suspended
 * for the whole migration (see migrate.js), which is what makes the drop safe and
 * is also why every ON DELETE action above had to be performed by hand.
 */
function rebuildListings(db) {
  db.exec(`
    CREATE TABLE listings__new (
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
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','gone','deleted')),
      state_reason TEXT,
      state_at INTEGER
    );

    INSERT INTO listings__new
      (id, created_at, last_seen_at, provider, price, size, rooms, title, image_url,
       address, link, latitude, longitude, state, state_reason, state_at)
    SELECT id, created_at, created_at, provider,
           CAST(price AS REAL), CAST(size AS REAL), CAST(rooms AS REAL),
           title, image_url, address, link, latitude, longitude,
           'active', NULL, NULL
    FROM listings;

    DROP TABLE listings;
    ALTER TABLE listings__new RENAME TO listings;
  `);
}

/**
 * Prove the migration left the database referentially sound.
 *
 * Foreign keys were suspended while it ran, so this is not a formality — it is
 * the check that was suspended, performed once at the end over the finished
 * shape, where it can report every violation instead of aborting on the first.
 */
function assertReferentialIntegrity(db) {
  const violations = db.pragma('foreign_key_check');
  if (violations.length) {
    const summary = [...new Set(violations.map((row) => `${row.table} -> ${row.parent}`))].join(', ');
    throw new Error(
      `Migration left ${violations.length} foreign key violation(s) (${summary}). ` +
        `Rolling back rather than starting against a database that cannot be trusted.`,
    );
  }
}

/* ------------------------------ current shape ----------------------------- */

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

    -- Facts only. Everything a job decided about these facts lives in
    -- listing_verdicts, and everything that never became facts at all lives in
    -- source_rejections.
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
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','gone','deleted')),
      state_reason TEXT,
      state_at INTEGER
    );

    -- One row per (listing, job). The tier/config/evidence triple is what lets a
    -- later stage ask "has this already been decided, under this configuration,
    -- on evidence that has not changed?" without re-deriving the answer.
    --
    -- config_hash is per job on purpose: two jobs with different polygons hold
    -- different hashes, so each re-evaluates for itself and neither inherits the
    -- other's verdict. Widening a blacklist changes the hash and reopens
    -- everything exactly once, which is the property the old short-circuit had
    -- and the one thing it was right about.
    CREATE TABLE IF NOT EXISTS listing_verdicts (
      listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL CHECK (verdict IN ('accepted','rejected')),
      reason TEXT,
      stage TEXT NOT NULL CHECK (stage IN ('discovery','detail','extraction')),
      tier TEXT NOT NULL CHECK (tier IN ('card','geo','llm')),
      config_hash TEXT NOT NULL,
      evidence_hash TEXT,
      origin TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','migrated')),
      decided_at INTEGER NOT NULL,
      notified_at INTEGER,
      CHECK ((verdict = 'rejected') = (reason IS NOT NULL)),
      PRIMARY KEY (listing_id, job_id)
    ) WITHOUT ROWID;

    -- A rejection that never reached extraction. It is not a listing: there are
    -- no canonical facts behind it, only the card that was refused. The card
    -- facts are kept so the verdict can be re-derived cheaply when the evidence
    -- changes, and the identity claims that point here are what stop the same
    -- advert being re-decided on every discovery run.
    --
    -- Deliberately no job_id: listing_sources.job_id already scopes it, and
    -- deleting a job cascades through that column for free.
    CREATE TABLE IF NOT EXISTS source_rejections (
      source_id TEXT PRIMARY KEY REFERENCES listing_sources(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('discovery','detail')),
      tier TEXT NOT NULL CHECK (tier IN ('card','geo')),
      config_hash TEXT NOT NULL,
      evidence_hash TEXT,
      origin TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','migrated')),
      capture_hash TEXT,
      title TEXT,
      address TEXT,
      price REAL,
      size REAL,
      rooms REAL,
      decided_at INTEGER NOT NULL,
      decided_count INTEGER NOT NULL DEFAULT 1,
      last_seen_at INTEGER NOT NULL
    ) WITHOUT ROWID;

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

    -- The foreign key is new. Without it this table was the one place a deleted
    -- listing left orphans that neither foreign_key_check nor the maintenance
    -- report could see.
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

    CREATE TABLE IF NOT EXISTS listing_attributes (
      listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
      data TEXT NOT NULL DEFAULT '{}',
      schema_version INTEGER NOT NULL DEFAULT 4,
      parsed_at INTEGER
    );

    -- A claim is owned by exactly one subject, and a rejection is a subject too.
    -- The claim string stays the primary key because "one claim, one owner" is
    -- what makes a claim usable as an answer rather than a list of candidates;
    -- giving rejections their own table would have split that namespace and let
    -- one URL be owned twice.
    CREATE TABLE IF NOT EXISTS listing_claims (
      claim TEXT PRIMARY KEY,
      listing_id TEXT REFERENCES listings(id) ON DELETE CASCADE,
      source_id TEXT REFERENCES listing_sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      CHECK ((listing_id IS NULL) <> (source_id IS NULL))
    );

    CREATE TABLE IF NOT EXISTS pipeline_work (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
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

/* ------------------------------- leaf rebuilds ---------------------------- */

/**
 * Widen `listing_claims` so a claim may belong to a rejection instead of a
 * listing. `listing_id NOT NULL` cannot be relaxed by ALTER TABLE, so the table
 * is rebuilt; every existing row is listing-owned and copies across unchanged.
 */
function reshapeListingClaims(db) {
  if (columnExists(db, 'listing_claims', 'source_id')) return;
  rebuildLeafTable(db, 'listing_claims', {
    create: `
      CREATE TABLE listing_claims (
        claim TEXT PRIMARY KEY,
        listing_id TEXT REFERENCES listings(id) ON DELETE CASCADE,
        source_id TEXT REFERENCES listing_sources(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        CHECK ((listing_id IS NULL) <> (source_id IS NULL))
      )`,
    // Claims whose listing has already gone are dropped rather than carried as
    // ownerless rows the CHECK would refuse.
    copy: `
      INSERT INTO listing_claims (claim, listing_id, source_id, kind, first_seen_at)
      SELECT o.claim, o.listing_id, NULL, o.kind, o.first_seen_at
      FROM listing_claims__old o
      WHERE o.listing_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM listings l WHERE l.id = o.listing_id)`,
  });
}

/**
 * Give the score table the foreign key it never had. Pre-existing orphans are
 * purged first — they would otherwise fail the deferred check at COMMIT — and
 * counting them explicitly is the only report anyone has ever had of them.
 */
function reshapeModelScores(db) {
  if (foreignKeyTargets(db, 'homeserver_listing_model_scores').includes('listings')) return;
  const orphans = db
    .prepare(
      `SELECT COUNT(*) AS n FROM homeserver_listing_model_scores WHERE listing_id NOT IN (SELECT id FROM listings)`,
    )
    .get().n;
  if (orphans > 0) {
    db.exec(`DELETE FROM homeserver_listing_model_scores WHERE listing_id NOT IN (SELECT id FROM listings)`);
  }
  rebuildLeafTable(db, 'homeserver_listing_model_scores', {
    create: `
      CREATE TABLE homeserver_listing_model_scores (
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
      )`,
    copy: `INSERT INTO homeserver_listing_model_scores SELECT * FROM homeserver_listing_model_scores__old`,
  });
}

/* ---------------------------- legacy conversion --------------------------- */

/**
 * Convert a database whose listings carried their own verdict.
 *
 * Five passes, in an order the foreign keys force:
 *
 *   D  merge listings that are the same capture seen by different jobs
 *   V  give every (listing, job) pair the verdict that job actually reached
 *   R  move never-extracted rejections out of `listings` and onto their source
 *   C  guarantee every surviving subject owns at least one claim
 *   X  delete what R moved, after detaching every child by hand
 *
 * The whole thing is gated on `listings.hidden_reason`, which this run drops.
 */
function convertLegacyListings(db) {
  db.exec(`
    CREATE TEMP TABLE mig_hash_merge(loser TEXT PRIMARY KEY, winner TEXT NOT NULL);
    CREATE TEMP TABLE mig_rejected(id TEXT PRIMARY KEY, reason TEXT NOT NULL, stage TEXT NOT NULL, tier TEXT NOT NULL);
  `);
  mergeDuplicateCaptures(db);
  classifyRejections(db);
  synthesiseVerdicts(db);
  extractRejections(db);
  reanchorClaims(db);
  deleteRejectionListings(db);
  db.exec(`DROP TABLE mig_hash_merge; DROP TABLE mig_rejected;`);
}

/**
 * D — one row per capture.
 *
 * `UNIQUE(job_id, hash)` let each job store its own row for the same capture
 * bytes, because the replay claim was namespaced by job. The capture hash never
 * was: it is derived from the provider, the source key and the page, so rows
 * sharing one are the same advert and must collapse onto one listing.
 *
 * The survivor is elected the way the runtime elects one: visible before hidden,
 * then richer, then older, then by id so the result does not depend on scan
 * order.
 */
function mergeDuplicateCaptures(db) {
  db.exec(`
    INSERT INTO mig_hash_merge(loser, winner)
    WITH ranked AS (
      SELECT l.id,
             FIRST_VALUE(l.id) OVER (
               PARTITION BY l.hash
               ORDER BY
                 CASE WHEN l.hidden_reason IS NULL AND l.manually_deleted = 0 THEN 0 ELSE 1 END,
                 (SELECT COUNT(*) FROM listing_attributes a WHERE a.listing_id = l.id) DESC,
                 ((l.title IS NOT NULL AND l.title <> '') + (l.address IS NOT NULL)
                   + (l.price IS NOT NULL) + (l.size IS NOT NULL) + (l.rooms IS NOT NULL)) DESC,
                 COALESCE(l.created_at, 0) ASC,
                 l.id ASC
             ) AS winner
      FROM listings l
      WHERE l.hash IS NOT NULL AND l.hash <> ''
    )
    SELECT id, winner FROM ranked WHERE id <> winner;
  `);

  // Children that allow many rows per listing simply repoint.
  for (const table of ['listing_images', 'listing_extractions', 'llm_call_audit', 'pipeline_audit_events']) {
    db.exec(`
      UPDATE ${table} SET listing_id = (SELECT winner FROM mig_hash_merge WHERE loser = listing_id)
      WHERE listing_id IN (SELECT loser FROM mig_hash_merge)`);
  }
  db.exec(`
    UPDATE listing_sources SET listing_id = (SELECT winner FROM mig_hash_merge WHERE loser = listing_id)
    WHERE listing_id IN (SELECT loser FROM mig_hash_merge);

    UPDATE listing_claims SET listing_id = (SELECT winner FROM mig_hash_merge WHERE loser = listing_id)
    WHERE listing_id IN (SELECT loser FROM mig_hash_merge);
  `);

  // Children keyed one-per-listing need a rule rather than a collision. Keep the
  // richest text and the newest attributes, matching what the runtime does.
  db.exec(`
    INSERT INTO listing_texts(listing_id, full_text, content_hash, captured_at)
    SELECT m.winner, t.full_text, t.content_hash, t.captured_at
    FROM listing_texts t JOIN mig_hash_merge m ON m.loser = t.listing_id
    WHERE EXISTS (SELECT 1 FROM listings l WHERE l.id = m.winner)
    ON CONFLICT(listing_id) DO UPDATE SET
      full_text    = CASE WHEN LENGTH(excluded.full_text) > LENGTH(full_text) THEN excluded.full_text    ELSE full_text    END,
      content_hash = CASE WHEN LENGTH(excluded.full_text) > LENGTH(full_text) THEN excluded.content_hash ELSE content_hash END,
      captured_at  = CASE WHEN LENGTH(excluded.full_text) > LENGTH(full_text) THEN excluded.captured_at  ELSE captured_at  END;

    INSERT INTO listing_attributes(listing_id, data, schema_version, parsed_at)
    SELECT m.winner, a.data, a.schema_version, a.parsed_at
    FROM listing_attributes a JOIN mig_hash_merge m ON m.loser = a.listing_id
    WHERE EXISTS (SELECT 1 FROM listings l WHERE l.id = m.winner)
    ON CONFLICT(listing_id) DO UPDATE SET
      data           = CASE WHEN COALESCE(excluded.parsed_at,0) > COALESCE(parsed_at,0) THEN excluded.data           ELSE data           END,
      schema_version = CASE WHEN COALESCE(excluded.parsed_at,0) > COALESCE(parsed_at,0) THEN excluded.schema_version ELSE schema_version END,
      parsed_at      = MAX(COALESCE(parsed_at,0), COALESCE(excluded.parsed_at,0));

    INSERT OR IGNORE INTO homeserver_listing_model_scores
    SELECT m.winner, s.model_family, s.model_version, s.scored_at, s.model_created_at,
           s.actual_price_per_sqm, s.fair_price_per_sqm, s.fair_lo_price_per_sqm, s.fair_hi_price_per_sqm,
           s.coverage_level, s.delta_percent, s.comps_500m, s.coord_quality, s.price_type, s.swap
    FROM homeserver_listing_model_scores s JOIN mig_hash_merge m ON m.loser = s.listing_id
    WHERE EXISTS (SELECT 1 FROM listings l WHERE l.id = m.winner);
  `);

  // The survivor was first seen whenever the earliest of the merged rows was.
  db.exec(`
    UPDATE listings SET created_at = COALESCE((
      SELECT MIN(COALESCE(x.created_at, listings.created_at))
      FROM listings x JOIN mig_hash_merge m ON m.loser = x.id
      WHERE m.winner = listings.id
    ), created_at)
    WHERE id IN (SELECT winner FROM mig_hash_merge);
  `);
}

/**
 * Which listings never became facts. A listing with attributes went through the
 * LLM and is a real market observation even when a filter then rejected it — the
 * price surface is trained on those. A listing without them is the output of the
 * old pre-LLM soft delete and has no business in the ledger.
 */
function classifyRejections(db) {
  db.exec(`
    INSERT INTO mig_rejected(id, reason, stage, tier)
    SELECT l.id,
           ${LEGACY_REASON_SQL('l.hidden_reason')},
           -- Never 'extraction': these rows have no attributes, so by definition
           -- nothing was ever extracted from them. A legacy reason that maps to
           -- the extraction stage is a reason the old schema recorded on a row it
           -- had already given up on.
           'detail',
           CASE WHEN ${LEGACY_TIER_SQL('l.hidden_reason')} = 'geo' THEN 'geo' ELSE 'card' END
    FROM listings l
    WHERE NOT EXISTS (SELECT 1 FROM listing_attributes a WHERE a.listing_id = l.id)
      AND l.id NOT IN (SELECT loser FROM mig_hash_merge);
  `);
}

/**
 * V — the verdict each job actually reached.
 *
 * Two sources, in priority order: the verdict recorded on that job's own source
 * row, then the global one the listing carried. Nothing is invented; where the
 * old schema only ever held one answer, that answer is inherited.
 *
 * Every row is `origin = 'migrated'` with a config hash that cannot match any
 * real one, so the gate declines on all of them and the first genuine capture
 * per job re-decides. A migration that presented guesses as decisions would
 * cement the bug it exists to remove.
 */
function synthesiseVerdicts(db) {
  db.exec(`
    INSERT INTO listing_verdicts
      (listing_id, job_id, verdict, reason, stage, tier, config_hash, evidence_hash, origin, decided_at, notified_at)
    WITH pairs AS (
      -- A row merged away in phase D still holds the verdict its job reached, so
      -- it is attributed to the survivor rather than dropped. Its sources were
      -- repointed already; this is for the verdict the listing itself carried.
      SELECT COALESCE((SELECT m.winner FROM mig_hash_merge m WHERE m.loser = l.id), l.id) AS listing_id,
             l.job_id AS job_id, l.hidden_reason AS src_reason,
             1 AS owner, COALESCE(l.created_at, 0) AS decided_at
      FROM listings l
      WHERE l.job_id IS NOT NULL AND l.id NOT IN (SELECT id FROM mig_rejected)
      UNION ALL
      SELECT s.listing_id, s.job_id,
             COALESCE(s.hidden_reason, (SELECT x.hidden_reason FROM listings x WHERE x.id = s.listing_id)),
             0, s.first_seen_at
      FROM listing_sources s
      WHERE s.listing_id IS NOT NULL AND s.listing_id NOT IN (SELECT id FROM mig_rejected)
    ),
    elected AS (
      SELECT listing_id, job_id, src_reason, decided_at,
             ROW_NUMBER() OVER (
               PARTITION BY listing_id, job_id
               ORDER BY (src_reason IS NOT NULL) DESC, owner DESC, decided_at ASC
             ) AS rank
      FROM pairs
    )
    SELECT e.listing_id, e.job_id,
           CASE WHEN e.src_reason IS NULL THEN 'accepted' ELSE 'rejected' END,
           CASE WHEN e.src_reason IS NULL THEN NULL ELSE ${LEGACY_REASON_SQL('e.src_reason')} END,
           ${LEGACY_STAGE_SQL('e.src_reason')},
           ${LEGACY_TIER_SQL('e.src_reason')},
           'migrated', NULL, 'migrated', e.decided_at,
           (SELECT w.updated_at FROM pipeline_work w
             WHERE w.kind = 'notify' AND w.key = e.listing_id AND w.status = 'sent')
    FROM elected e
    JOIN jobs j ON j.id = e.job_id
    JOIN listings l ON l.id = e.listing_id
    -- Filtered on the resolved listing, not the row the verdict was read from. A
    -- merged-away row maps onto its survivor, and that survivor may itself be a
    -- rejection on its way out of the ledger; checking the row the verdict came
    -- from instead wrote verdicts for listings this same migration then deleted.
    WHERE e.rank = 1
      AND e.listing_id NOT IN (SELECT id FROM mig_rejected)
      AND e.listing_id NOT IN (SELECT loser FROM mig_hash_merge)
    ON CONFLICT(listing_id, job_id) DO NOTHING;
  `);
}

/**
 * R — move never-extracted rejections onto their sources.
 *
 * A rejection has to hang off something that survives, and `listing_sources` is
 * already the right grain. Rows that somehow have no source at all get one
 * synthesised, because the alternative is losing the fact that the advert was
 * ever decided and re-deciding it forever.
 */
function extractRejections(db) {
  db.exec(`
    INSERT OR IGNORE INTO listing_sources
      (id, job_id, provider, source_key, source_url, listing_id, dedupe_keys_json, first_seen_at, last_seen_at)
    SELECT 'mig-' || l.id, l.job_id, COALESCE(l.provider, 'unknown'), 'migrated:' || l.id,
           COALESCE(l.link, ''), l.id, '[]', COALESCE(l.created_at, 0), COALESCE(l.created_at, 0)
    FROM listings l
    JOIN mig_rejected r ON r.id = l.id
    JOIN jobs j ON j.id = l.job_id
    WHERE NOT EXISTS (SELECT 1 FROM listing_sources s WHERE s.listing_id = l.id);

    INSERT INTO source_rejections
      (source_id, reason, stage, tier, config_hash, evidence_hash, origin, capture_hash,
       title, address, price, size, rooms, decided_at, decided_count, last_seen_at)
    SELECT s.id, r.reason,
           CASE WHEN s.dedupe_stage = 'discovery' THEN 'discovery' ELSE r.stage END,
           r.tier, 'migrated', NULL, 'migrated', l.hash,
           l.title, l.address, l.price, l.size, l.rooms,
           COALESCE(l.created_at, s.first_seen_at, 0),
           MAX(1, (SELECT COUNT(*) FROM pipeline_audit_events e
                    WHERE e.source_id = s.id AND e.stage = 'pre_llm_filter')),
           s.last_seen_at
    FROM listing_sources s
    JOIN mig_rejected r ON r.id = s.listing_id
    JOIN listings l ON l.id = s.listing_id
    ON CONFLICT(source_id) DO NOTHING;
  `);
}

/**
 * C — every surviving subject owns at least one claim.
 *
 * A subject with no claim can never be recognised again, so it comes back as a
 * fresh row on the next capture whose page text differs at all. The maintenance
 * report treats that as a data-integrity failure, and it is right to.
 */
function reanchorClaims(db) {
  db.exec(`
    -- C1. The replay claim loses its job prefix. Two jobs that captured the same
    -- advert produced 'cap:<job>|<hash>' twice for what is now one listing; both
    -- rewrite to 'cap:<hash>' and the second is absorbed. Idempotent: after this
    -- there is no '|' left to find.
    INSERT OR IGNORE INTO listing_claims (claim, listing_id, source_id, kind, first_seen_at)
    SELECT 'cap:' || substr(c.claim, instr(c.claim, '|') + 1), c.listing_id, NULL, 'cap', c.first_seen_at
    FROM listing_claims c
    WHERE c.kind = 'cap' AND instr(c.claim, '|') > 0
      AND c.listing_id IS NOT NULL
      AND c.listing_id NOT IN (SELECT id FROM mig_rejected);
    DELETE FROM listing_claims WHERE kind = 'cap' AND instr(claim, '|') > 0;

    -- C2. Claims still pointing at a listing that is about to become a rejection
    -- move to that rejection's own source, so the advert stays recognisable.
    UPDATE listing_claims
       SET source_id = (
             SELECT s.id FROM listing_sources s
             WHERE s.listing_id = listing_claims.listing_id
             ORDER BY s.first_seen_at ASC, s.id ASC LIMIT 1),
           listing_id = NULL
     WHERE listing_id IN (SELECT id FROM mig_rejected)
       AND EXISTS (SELECT 1 FROM listing_sources s WHERE s.listing_id = listing_claims.listing_id);
    DELETE FROM listing_claims WHERE listing_id IS NULL AND source_id IS NULL;

    -- C3. The source identity claim, which is what the detail-stage lookup asks
    -- for. Pure string concatenation of what the source row already holds.
    INSERT OR IGNORE INTO listing_claims (claim, listing_id, source_id, kind, first_seen_at)
    SELECT 'src:' || s.provider || ':' || s.source_key,
           CASE WHEN s.listing_id IS NOT NULL AND r.id IS NULL THEN s.listing_id END,
           CASE WHEN s.listing_id IS NULL OR  r.id IS NOT NULL THEN s.id END,
           'src', s.first_seen_at
    FROM listing_sources s
    LEFT JOIN mig_rejected r ON r.id = s.listing_id
    WHERE s.provider IS NOT NULL AND s.source_key IS NOT NULL
      AND (s.listing_id IS NULL OR r.id IS NOT NULL OR EXISTS (SELECT 1 FROM listings l WHERE l.id = s.listing_id));

    -- C4. A replay claim for any surviving listing that still owns none.
    INSERT OR IGNORE INTO listing_claims (claim, listing_id, source_id, kind, first_seen_at)
    SELECT 'cap:' || l.hash, l.id, NULL, 'cap', COALESCE(l.created_at, 0)
    FROM listings l
    WHERE l.hash IS NOT NULL AND l.hash <> ''
      AND l.id NOT IN (SELECT id FROM mig_rejected)
      AND NOT EXISTS (SELECT 1 FROM listing_claims c WHERE c.listing_id = l.id);

    INSERT OR IGNORE INTO listing_claims (claim, listing_id, source_id, kind, first_seen_at)
    SELECT 'cap:' || r.capture_hash, NULL, r.source_id, 'cap', r.decided_at
    FROM source_rejections r
    WHERE r.capture_hash IS NOT NULL AND r.capture_hash <> ''
      AND NOT EXISTS (SELECT 1 FROM listing_claims c WHERE c.source_id = r.source_id);

    -- C5. Terminal coercion. A subject can still be bare here if another row
    -- already owns its capture hash. A self-claim matches nothing else, so it
    -- does no dedupe work — it only keeps the invariant unconditional. It should
    -- fire zero times; the verification counts it so we know when it did not.
    INSERT OR IGNORE INTO listing_claims (claim, listing_id, source_id, kind, first_seen_at)
    SELECT 'cap:migrated:' || l.id, l.id, NULL, 'cap', COALESCE(l.created_at, 0)
    FROM listings l
    WHERE l.id NOT IN (SELECT id FROM mig_rejected)
      AND NOT EXISTS (SELECT 1 FROM listing_claims c WHERE c.listing_id = l.id);

    INSERT OR IGNORE INTO listing_claims (claim, listing_id, source_id, kind, first_seen_at)
    SELECT 'cap:migrated:' || r.source_id, NULL, r.source_id, 'cap', r.decided_at
    FROM source_rejections r
    JOIN listing_sources s ON s.id = r.source_id
    WHERE NOT EXISTS (SELECT 1 FROM listing_claims c WHERE c.source_id = r.source_id)
      -- and no claim recognises this advert at all. Three jobs finding one advert
      -- produce three sources whose 'src:' claim is the same string, and a claim
      -- has exactly one owner, so two of them own nothing — while the advert is
      -- perfectly recognisable through the third. Minting a self-claim for those
      -- adds a row that can never match anything.
      AND NOT EXISTS (
        SELECT 1 FROM listing_claims c
        WHERE c.claim = 'src:' || s.provider || ':' || s.source_key
      );
  `);
}

/**
 * X — delete the listings that became rejections.
 *
 * Every child is detached by hand first. This is not defensive style: a cascade
 * cannot be switched off here. `PRAGMA foreign_keys = OFF` is a silent no-op
 * inside a transaction, and `defer_foreign_keys` postpones the violation check,
 * not the cascading action — a plain DELETE would take `listing_images` with it,
 * and scheduled maintenance would then unlink every image file those rows point
 * at, because an image nothing references is by definition an orphan.
 */
function deleteRejectionListings(db) {
  db.exec(`
    -- Keep the rows, and therefore the files. queue_id is the real key here.
    UPDATE listing_images SET listing_id = NULL WHERE listing_id IN (SELECT id FROM mig_rejected);
    UPDATE listing_extractions SET listing_id = NULL WHERE listing_id IN (SELECT id FROM mig_rejected);

    DELETE FROM homeserver_listing_model_scores WHERE listing_id IN (SELECT id FROM mig_rejected);
    DELETE FROM pipeline_work WHERE kind IN ('rate','notify') AND key IN (SELECT id FROM mig_rejected);
    -- The captured page text of an advert that was refused before anything read
    -- it. Worth 13 MB of the 17 the text table holds, and worth more than that in
    -- not having to reason about which texts belong to listings.
    DELETE FROM listing_texts WHERE listing_id IN (SELECT id FROM mig_rejected);
    DELETE FROM listing_attributes WHERE listing_id IN (SELECT id FROM mig_rejected);
    DELETE FROM listing_claims WHERE listing_id IN (SELECT id FROM mig_rejected);

    -- Foreign keys are suspended, so ON DELETE SET NULL does not fire either.
    -- History is preserved and the pointer cleared, by hand.
    UPDATE llm_call_audit SET listing_id = NULL WHERE listing_id IN (SELECT id FROM mig_rejected);
    UPDATE pipeline_audit_events SET listing_id = NULL WHERE listing_id IN (SELECT id FROM mig_rejected);
    UPDATE listing_sources SET listing_id = NULL WHERE listing_id IN (SELECT id FROM mig_rejected);

    DELETE FROM listings WHERE id IN (SELECT id FROM mig_rejected);

    -- The merge losers go the same way, and by now nothing points at them.
    UPDATE listing_images SET listing_id = NULL WHERE listing_id IN (SELECT loser FROM mig_hash_merge);
    UPDATE listing_extractions SET listing_id = NULL WHERE listing_id IN (SELECT loser FROM mig_hash_merge);
    DELETE FROM homeserver_listing_model_scores WHERE listing_id IN (SELECT loser FROM mig_hash_merge);
    DELETE FROM pipeline_work WHERE kind IN ('rate','notify') AND key IN (SELECT loser FROM mig_hash_merge);
    DELETE FROM listing_texts WHERE listing_id IN (SELECT loser FROM mig_hash_merge);
    DELETE FROM listing_attributes WHERE listing_id IN (SELECT loser FROM mig_hash_merge);
    DELETE FROM listing_claims WHERE listing_id IN (SELECT loser FROM mig_hash_merge);
    UPDATE llm_call_audit SET listing_id = NULL WHERE listing_id IN (SELECT loser FROM mig_hash_merge);
    UPDATE pipeline_audit_events SET listing_id = NULL WHERE listing_id IN (SELECT loser FROM mig_hash_merge);
    UPDATE listing_sources SET listing_id = NULL WHERE listing_id IN (SELECT loser FROM mig_hash_merge);
    DELETE FROM listings WHERE id IN (SELECT loser FROM mig_hash_merge);
  `);
}

/* -------------------------- legacy value vocabulary ----------------------- */

/*
 * The old reason codes named the stage that produced them ('blacklist_pre_llm')
 * or the filter that fired ('spec_filter'), inconsistently and in one string.
 * The current shape separates what was decided from where, so every legacy code
 * maps onto a (reason, stage, tier) triple. Anything unrecognised — including a
 * row that was hidden with no reason at all — becomes 'no_detail', which is the
 * honest label for "we never got usable evidence" and the code the market corpus
 * already excludes.
 */
const LEGACY_REASON_SQL = (column) => `
  CASE ${column}
    WHEN 'blacklist_pre_llm' THEN 'blacklist'
    WHEN 'blacklist'         THEN 'blacklist'
    WHEN 'intent_filter'     THEN 'intent'
    WHEN 'spec_filter'       THEN 'spec'
    WHEN 'area_filter'       THEN 'area'
    WHEN 'no_price'          THEN 'no_price'
    WHEN 'no_coordinates'    THEN 'no_coordinates'
    ELSE 'no_detail'
  END`;

const LEGACY_STAGE_SQL = (column) => `
  CASE ${column}
    WHEN 'blacklist_pre_llm' THEN 'detail'
    WHEN 'intent_filter'     THEN 'extraction'
    WHEN 'blacklist'         THEN 'extraction'
    WHEN 'no_price'          THEN 'extraction'
    WHEN 'no_coordinates'    THEN 'extraction'
    WHEN 'spec_filter'       THEN 'detail'
    WHEN 'area_filter'       THEN 'detail'
    ELSE 'extraction'
  END`;

const LEGACY_TIER_SQL = (column) => `
  CASE ${column}
    WHEN 'blacklist_pre_llm' THEN 'card'
    WHEN 'spec_filter'       THEN 'card'
    WHEN 'area_filter'       THEN 'geo'
    ELSE 'llm'
  END`;

/* --------------------------- retirement and indexes ----------------------- */

/**
 * Indexes must go before the columns they name: SQLite refuses to drop a column
 * an index still mentions, and the error names the index rather than the column,
 * which is a confusing way to learn this.
 */
function dropRetiredIndexes(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_listings_status;
    DROP INDEX IF EXISTS idx_listings_job_hash;
  `);
}

/**
 * Columns whose feature has been removed. Idempotent, and the reason this file
 * still has to touch an existing database at all: dropping the code and the
 * CREATE TABLE definition would otherwise leave the columns behind on any
 * database that already has them.
 *
 * `listings` is not here — it is rebuilt wholesale by {@link rebuildListings},
 * because the column that has to go is named in a table-level foreign key and
 * SQLite will not drop one of those.
 */
function dropRetiredColumns(db) {
  // Supplemental image analysis, removed entirely.
  for (const column of ['visual_json', 'vision_model', 'vision_duration_ms']) {
    dropColumn(db, 'listing_extractions', column);
  }
  // The verdict moved to source_rejections, where it has a stage and a tier.
  dropColumn(db, 'listing_sources', 'hidden_reason');
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
    CREATE INDEX IF NOT EXISTS idx_listing_verdicts_job
      ON listing_verdicts(job_id, verdict, decided_at DESC);
    CREATE INDEX IF NOT EXISTS idx_listing_verdicts_accepted
      ON listing_verdicts(listing_id) WHERE verdict = 'accepted';
    CREATE INDEX IF NOT EXISTS idx_source_rejections_reason
      ON source_rejections(reason, decided_at DESC);
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
    CREATE INDEX IF NOT EXISTS idx_listing_claims_listing ON listing_claims(listing_id);
    CREATE INDEX IF NOT EXISTS idx_listing_claims_source ON listing_claims(source_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_work_claim
      ON pipeline_work(kind, status, next_attempt_at, lease_until);
    CREATE INDEX IF NOT EXISTS idx_homeserver_market_surface_cells_confidence
      ON homeserver_market_surface_cells(confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_homeserver_model_runs_created_at
      ON homeserver_model_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_homeserver_listing_model_scores_family
      ON homeserver_listing_model_scores(model_family, scored_at DESC);
  `);
}

/**
 * The shape name, so "which model is this database in?" is answerable from the
 * database. The migration ledger records a checksum, which says whether the file
 * changed but not what it changed into.
 */
function recordSchemaShape(db) {
  db.prepare(
    `INSERT INTO pipeline_control (name, value, updated_at) VALUES ('schema_shape', ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run('per-job-verdicts/1', Date.now());
}

/* --------------------------------- helpers -------------------------------- */

function dropColumn(db, table, column) {
  if (columnExists(db, table, column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

function columnExists(db, table, column) {
  return Boolean(db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column));
}

function foreignKeyTargets(db, table) {
  return db.pragma(`foreign_key_list("${table}")`).map((fk) => fk.table);
}

/** Every table whose foreign keys name this one. */
function referencingTables(db, table) {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ?`)
    .all(table)
    .filter(({ name }) => foreignKeyTargets(db, name).includes(table))
    .map(({ name }) => name);
}

/**
 * Rename-create-copy-drop, refused unless the table is a leaf.
 *
 * `ALTER TABLE ... RENAME` rewrites every REFERENCES clause that names the
 * table, so renaming a parent silently repoints its children at the temporary
 * copy and the final DROP cascade-deletes them. Renaming `listings` this way
 * empties `listing_images`, and scheduled maintenance then unlinks every image
 * file on disk, because an image no row references is an orphan. The guard is
 * the only thing standing between a future edit and that outcome.
 */
function rebuildLeafTable(db, table, { create, copy }) {
  const parents = referencingTables(db, table);
  if (parents.length) {
    throw new Error(
      `Refusing to rebuild ${table}: ${parents.join(', ')} reference it. ` +
        `ALTER TABLE RENAME would repoint their foreign keys at the temporary copy, ` +
        `and dropping it would cascade into them.`,
    );
  }
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}__old`);
  db.exec(create);
  db.exec(copy);
  db.exec(`DROP TABLE ${table}__old`);
}
