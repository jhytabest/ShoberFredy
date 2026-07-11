/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Shoberfredy market tables:
 * - homeserver_geocode_cache: persistent Google geocode results keyed by
 *   normalized address (written by the geocoding service and backfill CLI).
 * - homeserver_listing_scores: save-time market score per listing.
 * - homeserver_model_runs / homeserver_listing_market_model /
 *   homeserver_market_surface_cells / homeserver_model_state: output of the
 *   market model daemon (tools/market/marketModel.js).
 *
 * Everything is IF NOT EXISTS: databases migrated from the previous
 * patched-image deployment already contain these tables with data.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.exec(`
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

    CREATE TABLE IF NOT EXISTS homeserver_listing_scores (
      listing_id TEXT PRIMARY KEY,
      scored_at INTEGER NOT NULL,
      model_created_at INTEGER,
      actual_price_per_sqm REAL NOT NULL,
      fair_price_per_sqm REAL NOT NULL,
      delta_percent REAL NOT NULL,
      z_score REAL NOT NULL,
      confidence REAL NOT NULL,
      comps_500m INTEGER NOT NULL,
      price_type TEXT,
      swap INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS homeserver_model_runs (
      id TEXT PRIMARY KEY,
      model_version TEXT NOT NULL,
      training_rows INTEGER NOT NULL,
      scored_rows INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      metrics_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_homeserver_model_runs_created_at
      ON homeserver_model_runs (created_at DESC);

    CREATE TABLE IF NOT EXISTS homeserver_listing_market_model (
      listing_id TEXT PRIMARY KEY,
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
      residual_price_per_sqm REAL NOT NULL,
      delta_percent REAL NOT NULL,
      z_score REAL,
      percentile REAL,
      confidence REAL NOT NULL,
      nearby_comps_250m INTEGER NOT NULL,
      nearby_comps_500m INTEGER NOT NULL,
      nearby_comps_1000m INTEGER NOT NULL,
      geo_cell TEXT NOT NULL,
      area TEXT NOT NULL,
      size_band TEXT NOT NULL,
      rooms_band TEXT NOT NULL,
      feature_flags_json TEXT NOT NULL,
      geocode_quality TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES homeserver_model_runs (id)
    );

    CREATE INDEX IF NOT EXISTS idx_homeserver_listing_market_model_delta
      ON homeserver_listing_market_model (delta_percent ASC);
    CREATE INDEX IF NOT EXISTS idx_homeserver_listing_market_model_area
      ON homeserver_listing_market_model (area, rooms_band, size_band);

    CREATE TABLE IF NOT EXISTS homeserver_market_surface_cells (
      cell_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
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
      surface_components_json TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES homeserver_model_runs (id)
    );

    CREATE INDEX IF NOT EXISTS idx_homeserver_market_surface_cells_confidence
      ON homeserver_market_surface_cells (confidence DESC);

    CREATE TABLE IF NOT EXISTS homeserver_model_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      run_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      state_json TEXT NOT NULL
    );
  `);
}
