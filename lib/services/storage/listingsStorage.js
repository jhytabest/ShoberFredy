/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from './SqliteConnection.js';
import { saveListingText } from './listingTextStorage.js';
import { nanoid } from 'nanoid';
import { upsertListingAttributes } from '../listings/attributes.js';

/**
 * Persist a batch of scraped listings for a given job and provider.
 *
 * - Empty or non-array inputs are ignored.
 * - Each listing is inserted with ON CONFLICT(hash) DO NOTHING to avoid duplicates.
 * - Performs inserts in a single transaction for performance.
 * - Listings that failed the job's filters are stored HIDDEN
 *   (manually_deleted = 1) with the failure recorded in hidden_reason —
 *   filters decide visibility, not storage.
 * - Structured attributes (item.attributes, from the LLM extraction) and the
 *   pre-save market score (item.marketScore) are persisted in the same
 *   transaction when present.
 *
 * Listing input shape (minimal expected):
 * {
 *   id: string,            // unique id
 *   hash: string           // stable hash/id of the listing (used as unique hash)
 *   price?: string,        // e.g., "1.234 €" or "1,234€"
 *   size?: string,         // e.g., "70 m²"
 *   title?: string,
 *   image?: string,        // image URL
 *   fullText?: string,
 *   address?: string,      // free-text address possibly containing parentheses
 *   link?: string,
 *   hidden_reason?: string|null, // 'blacklist' | 'blacklist_pre_llm' | 'intent_filter' |
 *                                // 'spec_filter' | 'area_filter' | 'no_price' | 'no_coordinates'
 *   attributes?: object,   // structured LLM attributes (+ features flags)
 *   marketScore?: object   // scoreListingNow output
 * }
 *
 * @param {string} jobId - The job identifier.
 * @param {string} providerId - The provider identifier.
 * @param {Array<Object>} listings - Array of listing objects as described above.
 * @returns {void}
 */
export const storeListings = (jobId, providerId, listings) => {
  if (!Array.isArray(listings) || listings.length === 0) {
    return [];
  }

  const storedIds = [];
  SqliteConnection.withTransaction((db) => {
    const stmt = db.prepare(
      `INSERT INTO listings (id, hash, provider, job_id, price, size, rooms, title, image_url, address,
                             link, created_at, is_active, latitude, longitude, manually_deleted, hidden_reason,
                             source_urls_json, filter_reasons_json)
       VALUES (@id, @hash, @provider, @job_id, @price, @size, @rooms, @title, @image_url, @address, @link,
               @created_at, 1, @latitude, @longitude, @manually_deleted, @hidden_reason,
               @source_urls_json, @filter_reasons_json)
       ON CONFLICT(job_id, hash) DO NOTHING`,
    );
    const scoreStmt = db.prepare(
      `INSERT OR REPLACE INTO homeserver_listing_model_scores (
         listing_id, model_family, model_version, scored_at, model_created_at,
         actual_price_per_sqm, fair_price_per_sqm, fair_lo_price_per_sqm, fair_hi_price_per_sqm,
         coverage_level, delta_percent, comps_500m, coord_quality, price_type, swap
       ) VALUES (
         @listingId, @modelFamily, @modelVersion, @scoredAt, @modelCreatedAt,
         @actualPricePerSqm, @fairPricePerSqm, @fairLoPricePerSqm, @fairHiPricePerSqm,
         @coverageLevel, @deltaPercent, @comps500m, @coordQuality, @priceType, @swap
       )`,
    );

    for (const item of listings) {
      const params = {
        id: nanoid(),
        hash: item.id,
        provider: providerId,
        job_id: jobId,
        price: item.price,
        size: item.size,
        rooms: item.rooms,
        title: item.title,
        image_url: item.image,
        // Address is already an LLM-normalized canonical value. Preserve it
        // verbatim; storage must never reinterpret or fall back to card data.
        address: item.address ?? null,
        link: item.link,
        created_at: item.created_at ?? Date.now(),
        latitude: item.latitude || null,
        longitude: item.longitude || null,
        manually_deleted: item.hidden_reason ? 1 : 0,
        hidden_reason: item.hidden_reason || null,
        source_urls_json: JSON.stringify([
          ...new Set([item.link, ...(item.sourceUrls || [])].filter((value) => typeof value === 'string' && value)),
        ]),
        filter_reasons_json: JSON.stringify(item.filterReasons || []),
      };
      const inserted = stmt.run(params);
      if (inserted.changes === 0) {
        const existing = db.prepare('SELECT id FROM listings WHERE job_id = ? AND hash = ?').get(jobId, item.id);
        if (existing?.id) params.id = existing.id;
      }
      // Propagate the DB primary key back so downstream pipeline steps use the correct id
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
            priceType: s.priceType ?? null,
            swap: s.swap ? 1 : 0,
          });
        }
      }
    }
  });

  return storedIds;
};
