/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../../lib/services/storage/SqliteConnection.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { refreshConfig } from '../../lib/utils.js';
import {
  enqueueCapture,
  getBackfillStatus,
  PIPELINE_SCHEMA_VERSION,
  setBackfillPaused,
} from '../../lib/services/pipeline/queueStorage.js';

await SqliteConnection.init();
await refreshConfig();
await runMigrations();

const command = process.argv[2] || 'status';
if (command === 'enqueue') enqueueAll();
else if (command === 'pause') setBackfillPaused(true);
else if (command === 'resume') setBackfillPaused(false);
else if (command !== 'status') {
  process.stderr.write('Usage: yarn parsing:backfill <enqueue|status|pause|resume>\n');
  process.exitCode = 1;
}

process.stdout.write(`${JSON.stringify(getBackfillStatus(), null, 2)}\n`);

function enqueueAll() {
  const db = SqliteConnection.getConnection();
  const rows = db
    .prepare(
      `SELECT l.*, a.cold_rent_eur, a.warm_rent_eur, a.service_charges_eur,
              a.heating_costs_eur, a.deposit_eur, a.price_type, a.floor,
              a.building_year, a.property_type, a.energy_class, a.pets_allowed,
              a.available_from, a.swap, a.features_json
       FROM listings l
       LEFT JOIN listing_attributes a ON a.listing_id = l.id
       WHERE l.provider IN ('immoscout', 'immowelt', 'wgGesucht', 'kleinanzeigen')
       ORDER BY l.created_at ASC`,
    )
    .all();

  let enqueued = 0;
  for (const row of rows) {
    const capture = {
      provider: row.provider,
      externalId: row.hash,
      sourceUrl: row.link,
      discoveredAt: row.created_at || Date.now(),
      discoveryData: {
        id: row.hash,
        link: row.link,
        title: row.title,
        price: row.price,
        size: row.size,
        rooms: row.rooms,
        address: row.address,
        image: row.image_url,
        description: row.description,
      },
      fullText: row.description || '',
      embeddedData: [{ kind: 'existing-listing-attributes', value: existingAttributes(row) }],
      images: row.image_url ? [{ position: 0, kind: 'photo', originalUrl: row.image_url }] : [],
      backfillSchemaVersion: PIPELINE_SCHEMA_VERSION,
    };
    const queueId = enqueueCapture({
      jobId: row.job_id,
      provider: row.provider,
      sourceHash: row.hash,
      capture,
      images: capture.images.map((image) => ({ ...image, downloadStatus: 'pending' })),
      queueKind: 'backfill',
      listingId: row.id,
    });
    if (queueId) enqueued++;
  }
  process.stdout.write(
    `Backfill queue contains ${enqueued} supported listings for schema v${PIPELINE_SCHEMA_VERSION}.\n`,
  );
}

function existingAttributes(row) {
  return {
    coldRentEur: row.cold_rent_eur,
    warmRentEur: row.warm_rent_eur,
    serviceChargesEur: row.service_charges_eur,
    heatingCostsEur: row.heating_costs_eur,
    depositEur: row.deposit_eur,
    priceType: row.price_type,
    floor: row.floor,
    buildingYear: row.building_year,
    propertyType: row.property_type,
    energyClass: row.energy_class,
    petsAllowed: row.pets_allowed,
    availableFrom: row.available_from,
    swap: row.swap,
    features: safeJson(row.features_json),
  };
}

function safeJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}
