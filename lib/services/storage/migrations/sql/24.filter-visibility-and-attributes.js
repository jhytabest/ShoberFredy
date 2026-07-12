/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { parseListingAttrs } from '../../../scoring/listingAttrs.js';
import { textFeatureFlags } from '../../../scoring/hedonicFeatures.js';

/**
 * Storage policy change: every non-duplicate listing is stored; job filters
 * (blacklist, specs, spatial) only decide VISIBILITY, recorded in
 * listings.hidden_reason ('blacklist' | 'spec_filter' | 'area_filter' |
 * 'no_coordinates'; NULL = visible or user-hidden).
 *
 * listing_attributes holds the structured facts recovered from listing text
 * at scrape time (rent breakdown, floor, year, property type, feature flags)
 * so the market model, scorer, and exporter no longer re-parse text on every
 * read. Existing rows are backfilled here.
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

  const rows = db.prepare(`SELECT id, provider, title, description, address, price, size, rooms FROM listings`).all();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO listing_attributes (
      listing_id, cold_rent_eur, warm_rent_eur, service_charges_eur, heating_costs_eur,
      deposit_eur, price_type, rooms, floor, building_year, property_type, energy_class,
      pets_allowed, available_from, swap, features_json, parsed_at
    ) VALUES (
      @listingId, @coldRentEur, @warmRentEur, @serviceChargesEur, @heatingCostsEur,
      @depositEur, @priceType, @rooms, @floor, @buildingYear, @propertyType, @energyClass,
      @petsAllowed, @availableFrom, @swap, @featuresJson, @parsedAt
    )
  `);
  const now = Date.now();
  for (const row of rows) {
    const attrs = parseListingAttrs(row);
    insert.run({
      listingId: row.id,
      coldRentEur: attrs.coldRentEur,
      warmRentEur: attrs.warmRentEur,
      serviceChargesEur: attrs.serviceChargesEur,
      heatingCostsEur: attrs.heatingCostsEur,
      depositEur: attrs.depositEur,
      priceType: attrs.priceType,
      rooms: attrs.rooms,
      floor: attrs.floor,
      buildingYear: attrs.buildingYear,
      propertyType: attrs.propertyType,
      energyClass: attrs.energyClass,
      petsAllowed: attrs.petsAllowed == null ? null : attrs.petsAllowed ? 1 : 0,
      availableFrom: attrs.availableFrom,
      swap: attrs.swap ? 1 : 0,
      featuresJson: JSON.stringify(textFeatureFlags(row.title, row.description, row.address)),
      parsedAt: now,
    });
  }
}
