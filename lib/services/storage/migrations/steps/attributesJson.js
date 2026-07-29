/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { columnExists, tableExists } from '../../../../shared/sqlite.js';

/**
 * Fold the 44-column listing_attributes table into one validated JSON document.
 *
 * The wide table forced the same field set to be written out by hand six times:
 * the LLM schema, the canonical builder, the SQL parameter map, a 44-column
 * upsert naming every column three times (duplicated across two modules), and
 * the inverse row-to-object mapper. Adding one field meant six correct edits and
 * nothing detected a miss.
 *
 * `data` holds the pipeline's own attributes object — the same camelCase shape
 * the canonical builder already produces and every consumer already wants — so
 * writing is a stringify and reading is a parse. Price, size, and rooms already
 * live on `listings`; duplicating them as generated columns here would create a
 * second SQL definition without enabling a query.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function migrateAttributesJson(db) {
  if (!tableExists(db, 'listing_attributes')) {
    createTable(db);
    return;
  }
  // Already folded: keep checksum re-runs convergent with the lean current
  // shape, including databases created during development of this migration.
  if (columnExists(db, 'listing_attributes', 'data')) {
    for (const column of ['price_eur', 'size_sqm', 'rooms']) {
      if (columnExists(db, 'listing_attributes', column)) {
        db.exec(`ALTER TABLE listing_attributes DROP COLUMN ${column}`);
      }
    }
    return;
  }

  const rows = db
    .prepare(
      `SELECT attributes.*, listing.size AS listing_size
       FROM listing_attributes attributes
       LEFT JOIN listings listing ON listing.id = attributes.listing_id`,
    )
    .all();

  db.exec('ALTER TABLE listing_attributes RENAME TO listing_attributes_wide;');
  createTable(db);

  const insert = db.prepare(
    `INSERT OR REPLACE INTO listing_attributes (listing_id, data, schema_version)
     VALUES (@listingId, @data, @schemaVersion)`,
  );
  for (const row of rows) {
    insert.run({
      listingId: row.listing_id,
      data: JSON.stringify(foldRow(row)),
      schemaVersion: row.schema_version ?? 4,
    });
  }

  db.exec('DROP TABLE listing_attributes_wide;');
}

function createTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_attributes (
      listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
      data TEXT NOT NULL DEFAULT '{}',
      schema_version INTEGER NOT NULL DEFAULT 4,
      parsed_at INTEGER
    );
  `);
}

const json = (value, fallback) => {
  if (value == null || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};
const bool = (value) => (value == null ? null : Boolean(value));

/**
 * Rebuild the attributes object from one wide row. This is the inverse of the
 * parameter map the finalizer used to hand-write, kept here rather than in the
 * runtime because it describes a schema that will not exist after this runs.
 */
function foldRow(row) {
  return {
    coldRentEur: row.cold_rent_eur ?? null,
    warmRentEur: row.warm_rent_eur ?? null,
    serviceChargesEur: row.service_charges_eur ?? null,
    heatingCostsEur: row.heating_costs_eur ?? null,
    depositEur: row.deposit_eur ?? null,
    priceType: row.price_type ?? 'unknown',
    sizeSqm: row.listing_size ?? null,
    rooms: row.rooms ?? null,
    floor: row.floor ?? null,
    buildingYear: row.building_year ?? null,
    propertyType: row.property_type ?? null,
    energyClass: row.energy_class ?? null,
    petsAllowed: bool(row.pets_allowed),
    petsPolicy: row.pets_policy ?? 'unknown',
    availability: row.availability ?? 'unknown',
    availabilityPrecision: row.availability_precision ?? 'unknown',
    availableFrom: row.available_from ?? null,
    availableUntil: row.available_until ?? null,
    swap: Boolean(row.swap),
    listingType: row.listing_type ?? 'unknown',
    bedrooms: row.bedrooms ?? null,
    bathrooms: row.bathrooms ?? null,
    totalFloors: row.total_floors ?? null,
    condition: row.condition ?? null,
    furnished: bool(row.furnished),
    furnishingStatus: row.furnishing_status ?? 'unknown',
    smokingPolicy: row.smoking_policy ?? 'unknown',
    leaseType: row.lease_type ?? 'unknown',
    minimumLeaseMonths: row.minimum_lease_months ?? null,
    maximumOccupants: row.maximum_occupants ?? null,
    heatingType: row.heating_type ?? null,
    energyValueKwh: row.energy_value_kwh ?? null,
    amenities: json(row.amenities_json, []),
    amenitiesAbsent: json(row.amenities_absent_json, []),
    features: json(row.features_json, {}),
    addressComponents: json(row.address_json, null),
    rentInclusions: json(row.rent_inclusions_json, []),
    requirements: json(row.requirements_json, []),
    conflicts: json(row.conflicts_json, []),
    recurringCosts: json(row.recurring_costs_json, {}),
    oneTimeBuyoutEur: row.one_time_buyout_eur ?? null,
    comments: row.comments ?? null,
    summary: row.summary ?? null,
  };
}
