/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Dual market models: the single-model state (geo-surface-v3) is replaced by
 * a model registry holding one artifact per model family ('ridge' and 'gbm'),
 * trained as equals every run and both rendered into notifications.
 *
 * - homeserver_models: one row per family; artifact_json carries everything
 *   the notification-time scorer needs (coefficients / dumped trees /
 *   conformal calibration). Replaces homeserver_model_state, which is dropped:
 *   its artifact shape (unstandardized beta, no intervals) is not scoreable by
 *   the v4 scorer, and the first retrain (~60s after boot) repopulates the
 *   registry. Until then scoring fails open, exactly like a fresh install.
 * - homeserver_listing_model_scores: save-time score per (listing, family)
 *   with conformal interval bounds. homeserver_listing_scores stays as a
 *   read-only legacy record of pre-v4 scores; nothing writes it anymore.
 * - homeserver_listing_market_model is rebuilt with model_family in the
 *   primary key (it is a full re-insert on every model run, so no data is
 *   worth preserving) and interval columns.
 * - homeserver_model_runs gains model_family so both families can report
 *   their own evaluation metrics side by side.
 * - listings gains the indices the trainers and the exporter scan by.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS homeserver_models (
      family TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      training_rows INTEGER NOT NULL,
      artifact_json TEXT NOT NULL,
      eval_json TEXT NOT NULL
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

    CREATE INDEX IF NOT EXISTS idx_homeserver_listing_model_scores_family
      ON homeserver_listing_model_scores (model_family, scored_at DESC);

    DROP TABLE IF EXISTS homeserver_model_state;
    DROP TABLE IF EXISTS homeserver_listing_market_model;

    CREATE TABLE homeserver_listing_market_model (
      listing_id TEXT NOT NULL,
      model_family TEXT NOT NULL,
      run_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      listing_created_at INTEGER,
      provider TEXT,
      link TEXT,
      title TEXT,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      actual_price_eur REAL NOT NULL,
      target_rent_eur REAL,
      price_type TEXT,
      size_sqm REAL NOT NULL,
      rooms REAL,
      actual_price_per_sqm REAL NOT NULL,
      predicted_price_per_sqm REAL NOT NULL,
      predicted_lo_price_per_sqm REAL,
      predicted_hi_price_per_sqm REAL,
      residual_price_per_sqm REAL NOT NULL,
      delta_percent REAL NOT NULL,
      z_score REAL,
      percentile REAL,
      confidence REAL,
      nearby_comps_250m INTEGER,
      nearby_comps_500m INTEGER,
      nearby_comps_1000m INTEGER,
      geo_cell TEXT,
      area TEXT,
      size_band TEXT,
      rooms_band TEXT,
      feature_flags_json TEXT,
      geocode_quality TEXT,
      PRIMARY KEY (listing_id, model_family)
    );

    CREATE INDEX IF NOT EXISTS idx_homeserver_listing_market_model_delta
      ON homeserver_listing_market_model (model_family, delta_percent ASC);
    CREATE INDEX IF NOT EXISTS idx_homeserver_listing_market_model_area
      ON homeserver_listing_market_model (area, rooms_band, size_band);

    CREATE INDEX IF NOT EXISTS idx_listings_created_at
      ON listings (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_listings_coordinates
      ON listings (latitude, longitude);
  `);

  const hasFamilyColumn = db
    .prepare(`SELECT 1 FROM pragma_table_info('homeserver_model_runs') WHERE name = 'model_family'`)
    .get();
  if (!hasFamilyColumn) {
    db.exec(`ALTER TABLE homeserver_model_runs ADD COLUMN model_family TEXT`);
  }
}
