/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Storage policy change: every non-duplicate listing is stored; job filters
 * (blacklist, specs, spatial) only decide VISIBILITY, recorded in
 * listings.hidden_reason ('blacklist' | 'spec_filter' | 'area_filter' |
 * 'no_coordinates'; NULL = visible or user-hidden).
 *
 * listing_attributes holds normalized structured facts. Existing rows are
 * intentionally left empty here; migration 29 queues every listing for the
 * single supported extraction path, the audited LLM parser.
 *
 * Legacy "zz Shadow" rows (adapterless jobs from the pre-Shoberfredy setup)
 * are tagged 'legacy_shadow' so future queries can tell them apart from
 * user-hidden listings.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.exec(`
    ALTER TABLE listings ADD COLUMN hidden_reason TEXT;

    CREATE TABLE IF NOT EXISTS listing_attributes (
      listing_id TEXT PRIMARY KEY,
      cold_rent_eur REAL,
      warm_rent_eur REAL,
      service_charges_eur REAL,
      heating_costs_eur REAL,
      deposit_eur REAL,
      price_type TEXT,
      rooms REAL,
      floor INTEGER,
      building_year INTEGER,
      property_type TEXT,
      energy_class TEXT,
      pets_allowed INTEGER,
      available_from TEXT,
      swap INTEGER NOT NULL DEFAULT 0,
      features_json TEXT NOT NULL,
      parsed_at INTEGER NOT NULL,
      FOREIGN KEY (listing_id) REFERENCES listings (id) ON DELETE CASCADE
    );

    UPDATE listings SET hidden_reason = 'legacy_shadow'
    WHERE manually_deleted = 1
      AND job_id IN (SELECT id FROM jobs WHERE json_array_length(notification_adapter) = 0);
  `);
}
