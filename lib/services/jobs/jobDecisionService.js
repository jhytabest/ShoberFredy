/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { filterListing } from '../pipeline/listingFilters.js';
import { listingAttributes } from '../listings/attributes.js';
import { getPipelineConfig } from '../storage/pipelineConfigStorage.js';
import { filterConfigHash, recordVerdict } from '../pipeline/terminalVerdict.js';
import { enqueueNotification } from '../pipeline/notificationOutbox.js';

export function decideListing(db, listing, config = getPipelineConfig(db)) {
  const facts = { ...listing, geocodeAccuracy: listing.geocodeAccuracy ?? listing.geocode_accuracy, attributes: listing.attributes ?? listingAttributes(listing) };
  return recordVerdict(db, facts, config.filters, filterListing(facts, config.filters));
}

export function reevaluateListings(db, limit = 100) {
  const config = getPipelineConfig(db);
  const rows = db.prepare(`SELECT l.*, a.data AS attributes_json FROM listings l
    JOIN listing_attributes a ON a.listing_id=l.id
    LEFT JOIN listing_decisions d ON d.listing_id=l.id
    WHERE NOT EXISTS (SELECT 1 FROM notification_suppressions s WHERE s.listing_id=l.id)
      AND (d.listing_id IS NULL OR d.config_hash != ? OR a.parsed_at > d.decided_at)
    ORDER BY l.created_at LIMIT ?`).all(filterConfigHash(config.filters), limit);
  db.transaction(() => {
    for (const row of rows) if (decideListing(db, row, config).accepted) enqueueNotification(row.id, config);
  })();
  return rows.length;
}
