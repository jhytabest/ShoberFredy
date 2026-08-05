/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from './SqliteConnection.js';
import { saveListingText } from './listingTextStorage.js';
import { nanoid } from 'nanoid';
import { upsertListingAttributes } from '../listings/attributes.js';

export const storeListings = (providerId, listings) => {
  if (!Array.isArray(listings) || listings.length === 0) {
    return [];
  }

  const storedIds = [];
  SqliteConnection.withTransaction((db) => {
    const stmt = db.prepare(
      `INSERT INTO listings (id, provider, price, size, rooms, title, image_url, address,
                             link, created_at, last_seen_at, latitude, longitude, state)
       VALUES (@id, @provider, @price, @size, @rooms, @title, @image_url, @address, @link,
               @created_at, @last_seen_at, @latitude, @longitude, 'active')`,
    );
    const scoreStmt = db.prepare(
      `INSERT OR REPLACE INTO homeserver_listing_model_scores (
         listing_id, model_family, model_version, scored_at, model_created_at,
         actual_price_per_sqm, fair_price_per_sqm, fair_lo_price_per_sqm, fair_hi_price_per_sqm,
         coverage_level, delta_percent, comps_500m, coord_quality, swap
       ) VALUES (
         @listingId, @modelFamily, @modelVersion, @scoredAt, @modelCreatedAt,
         @actualPricePerSqm, @fairPricePerSqm, @fairLoPricePerSqm, @fairHiPricePerSqm,
         @coverageLevel, @deltaPercent, @comps500m, @coordQuality, @swap
       )`,
    );

    for (const item of listings) {
      const now = Date.now();
      const params = {
        id: nanoid(),
        provider: providerId,
        price: item.price,
        size: item.size,
        rooms: item.rooms,
        title: item.title,
        image_url: item.image,
        address: item.address ?? null,
        link: item.link,
        created_at: item.created_at ?? now,
        last_seen_at: now,
        latitude: item.latitude || null,
        longitude: item.longitude || null,
      };
      stmt.run(params);
      item.id = params.id;
      storedIds.push(params.id);
      saveListingText(params.id, item.fullText, item.created_at ?? Date.now(), db);

      if (item.attributes) upsertListingAttributes(db, params.id, item.attributes);
      if (item.marketScore?.models) {
        const s = item.marketScore;
        for (const model of Object.values(s.models)) {
          if (!model) continue;
          scoreStmt.run({
            listingId: params.id,
            modelFamily: model.family,
            modelVersion: model.version ?? 'unknown',
            scoredAt: Date.now(),
            modelCreatedAt: model.modelCreatedAt ?? null,
            actualPricePerSqm: s.actualPricePerSqm,
            fairPricePerSqm: model.fairPricePerSqm,
            fairLoPricePerSqm: model.fairLoPricePerSqm ?? null,
            fairHiPricePerSqm: model.fairHiPricePerSqm ?? null,
            coverageLevel: model.coverageLevel ?? null,
            deltaPercent: model.deltaPercent,
            comps500m: model.comps500m ?? null,
            coordQuality: s.coordQuality ?? null,
            swap: s.swap ? 1 : 0,
          });
        }
      }
    }
  });

  return storedIds;
};
