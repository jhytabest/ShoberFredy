/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { fromJson } from '../../utils.js';
import SqliteConnection from './SqliteConnection.js';
import { saveListingText } from './listingTextStorage.js';
import { nanoid } from 'nanoid';

/**
 * Parse the JSON `status` column of a listing row in place.
 *
 * The DB stores status as a JSON payload `{ status, setAt }` (or NULL).
 * Consumers expect an object/null, so we normalize before returning.
 *
 * @param {Object|null|undefined} row - A raw row from the listings table.
 * @returns {Object|null|undefined} The same row with `status` parsed.
 */
const parseListingStatus = (row) => {
  if (row == null) return row;
  if (typeof row.status === 'string') {
    row.status = fromJson(row.status, null);
  }
  row.source_urls = fromJson(row.source_urls_json, row.link ? [row.link] : []);
  return row;
};

/**
 * Compute KPI aggregates for a given set of job IDs from the listings table.
 *
 * - numberOfActiveListings: count of listings where is_active = 1
 * - medianPriceOfListings: median of numeric price, rounded to nearest integer
 *
 * When no jobIds are provided, returns zeros.
 *
 * @param {string[]} jobIds
 * @returns {{ numberOfActiveListings: number, medianPriceOfListings: number }}
 */
export const getListingsKpisForJobIds = (jobIds = []) => {
  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return { numberOfActiveListings: 0, medianPriceOfListings: 0 };
  }

  const placeholders = jobIds.map(() => '?').join(',');
  const rows = SqliteConnection.query(
    `SELECT is_active, price
     FROM listings
     WHERE job_id IN (${placeholders})
       AND manually_deleted = 0`,
    jobIds,
  );

  const activeCount = rows.filter((r) => r.is_active === 1).length;

  const prices = rows
    .map((r) => r.price)
    .filter((p) => p !== null)
    .sort((a, b) => a - b);

  let medianPrice = 0;
  if (prices.length > 0) {
    const mid = Math.floor(prices.length / 2);
    medianPrice = prices.length % 2 !== 0 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  }

  return {
    numberOfActiveListings: activeCount,
    medianPriceOfListings: medianPrice,
  };
};

/**
 * Compute distribution of listings by provider for the given set of job IDs.
 * Returns data ready for the pie chart component with fields `type` and `value` (percentage).
 *
 * Example return:
 * [ { type: 'immoscout', value: 62 }, { type: 'immowelt', value: 38 } ]
 *
 * When no jobIds are provided or no listings exist, returns empty array.
 *
 * @param {string[]} jobIds
 * @returns {{ type: string, value: number }[]}
 */
export const getProviderDistributionForJobIds = (jobIds = []) => {
  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return [];
  }

  const placeholders = jobIds.map(() => '?').join(',');
  const rows = SqliteConnection.query(
    `SELECT provider, COUNT(*) AS cnt
     FROM listings
     WHERE job_id IN (${placeholders})
       AND manually_deleted = 0
     GROUP BY provider
     ORDER BY cnt DESC`,
    jobIds,
  );

  const total = rows.reduce((acc, r) => acc + Number(r.cnt || 0), 0);
  if (total === 0) return [];

  // Map counts to integer percentage values (0-100). Ensure sum is ~100 by rounding.
  const percentages = rows.map((r) => ({
    type: r.provider,
    value: Math.round((Number(r.cnt) / total) * 100),
  }));

  // Adjust rounding drift to keep sum at 100 (optional minor correction)
  const drift = 100 - percentages.reduce((s, p) => s + p.value, 0);
  if (drift !== 0 && percentages.length > 0) {
    // apply drift to the largest slice to keep UX simple
    let maxIdx = 0;
    for (let i = 1; i < percentages.length; i++) {
      if (percentages[i].value > percentages[maxIdx].value) maxIdx = i;
    }
    percentages[maxIdx].value = Math.max(0, percentages[maxIdx].value + drift);
  }

  return percentages;
};

/**
 * Return a list of listing that either are active or have an unknown status
 * to constantly check if they are still online
 *
 * @returns {string[]} Array of listings
 */
export const getActiveOrUnknownListings = () => {
  return SqliteConnection.query(
    `SELECT *
     FROM listings
     WHERE (is_active is null OR is_active = 1)
       AND manually_deleted = 0
     ORDER BY provider`,
  );
};

/**
 * Deactivates listings and records when and why their lifecycle ended.
 *
 * @param {string[]} ids - Array of listing IDs to deactivate.
 * @param {string} [reason='provider_unreachable_or_inactive'] lifecycle reason
 * @returns {object[]} Result of the SQLite query execution.
 */
export const deactivateListings = (ids, reason = 'provider_unreachable_or_inactive') => {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return SqliteConnection.execute(
    `UPDATE listings
     SET is_active = 0, inactive_at = ?, inactive_reason = ?
     WHERE id IN (${placeholders})`,
    [Date.now(), reason, ...ids],
  );
};

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
    const attrsStmt = db.prepare(
      `INSERT OR REPLACE INTO listing_attributes (
         listing_id, cold_rent_eur, warm_rent_eur, service_charges_eur, heating_costs_eur,
         deposit_eur, price_type, rooms, floor, building_year, property_type, energy_class,
         pets_allowed, available_from, swap, features_json, parsed_at,
         listing_type, bedrooms, bathrooms, total_floors, condition, furnished,
         heating_type, energy_value_kwh, amenities_json, availability, comments,
         address_json, availability_precision, available_until, furnishing_status,
         pets_policy, smoking_policy, lease_type, minimum_lease_months, maximum_occupants,
         amenities_absent_json, rent_inclusions_json, requirements_json, conflicts_json,
         recurring_costs_json, one_time_buyout_eur, summary
       ) VALUES (
         @listingId, @coldRentEur, @warmRentEur, @serviceChargesEur, @heatingCostsEur,
         @depositEur, @priceType, @rooms, @floor, @buildingYear, @propertyType, @energyClass,
         @petsAllowed, @availableFrom, @swap, @featuresJson, @parsedAt,
         @listingType, @bedrooms, @bathrooms, @totalFloors, @condition, @furnished,
         @heatingType, @energyValueKwh, @amenitiesJson, @availability, @comments,
         @addressJson, @availabilityPrecision, @availableUntil, @furnishingStatus,
         @petsPolicy, @smokingPolicy, @leaseType, @minimumLeaseMonths, @maximumOccupants,
         @amenitiesAbsentJson, @rentInclusionsJson, @requirementsJson, @conflictsJson,
         @recurringCostsJson, @oneTimeBuyoutEur, @summary
       )`,
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

      if (item.attributes) {
        const a = item.attributes;
        attrsStmt.run({
          listingId: params.id,
          coldRentEur: a.coldRentEur ?? null,
          warmRentEur: a.warmRentEur ?? null,
          serviceChargesEur: a.serviceChargesEur ?? null,
          heatingCostsEur: a.heatingCostsEur ?? null,
          depositEur: a.depositEur ?? null,
          priceType: a.priceType ?? null,
          rooms: a.rooms ?? null,
          floor: a.floor ?? null,
          buildingYear: a.buildingYear ?? null,
          propertyType: a.propertyType ?? null,
          energyClass: a.energyClass ?? null,
          petsAllowed: a.petsAllowed == null ? null : a.petsAllowed ? 1 : 0,
          availableFrom: a.availableFrom ?? null,
          swap: a.swap ? 1 : 0,
          featuresJson: JSON.stringify(a.features ?? {}),
          parsedAt: Date.now(),
          listingType: a.listingType ?? null,
          bedrooms: a.bedrooms ?? null,
          bathrooms: a.bathrooms ?? null,
          totalFloors: a.totalFloors ?? null,
          condition: a.condition ?? null,
          furnished: a.furnished == null ? null : a.furnished ? 1 : 0,
          heatingType: a.heatingType ?? null,
          energyValueKwh: a.energyValueKwh ?? null,
          amenitiesJson: JSON.stringify(a.amenities ?? []),
          availability: a.availability ?? null,
          comments: a.comments ?? null,
          addressJson: a.addressComponents == null ? null : JSON.stringify(a.addressComponents),
          availabilityPrecision: a.availabilityPrecision ?? null,
          availableUntil: a.availableUntil ?? null,
          furnishingStatus: a.furnishingStatus ?? null,
          petsPolicy: a.petsPolicy ?? null,
          smokingPolicy: a.smokingPolicy ?? null,
          leaseType: a.leaseType ?? null,
          minimumLeaseMonths: a.minimumLeaseMonths ?? null,
          maximumOccupants: a.maximumOccupants ?? null,
          amenitiesAbsentJson: JSON.stringify(a.amenitiesAbsent ?? []),
          rentInclusionsJson: JSON.stringify(a.rentInclusions ?? []),
          requirementsJson: JSON.stringify(a.requirements ?? []),
          conflictsJson: JSON.stringify(a.conflicts ?? []),
          recurringCostsJson: JSON.stringify(a.recurringCosts ?? {}),
          oneTimeBuyoutEur: a.oneTimeBuyoutEur ?? null,
          summary: a.summary ?? null,
        });
      }

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

/**
 * Query listings with pagination, filtering and sorting.
 *
 * @param {Object} params
 * @param {number} [params.pageSize=50]
 * @param {number} [params.page=1]
 * @param {string} [params.freeTextFilter]
 * @param {object} [params.activityFilter]
 * @param {object} [params.jobNameFilter]
 * @param {object} [params.providerFilter]
 * @param {('applied'|'rejected'|'accepted'|'none')} [params.statusFilter] - Filter by listing status. 'none' matches NULL.
 * @param {string|null} [params.sortField=null] - One of: 'created_at','price','size','provider','title'.
 * @param {('asc'|'desc')} [params.sortDir='asc']
 * @param {number} [params.createdAfter] - Only include listings created at or after this unix timestamp (ms).
 * @param {number} [params.createdBefore] - Only include listings created at or before this unix timestamp (ms).
 * @param {boolean} [params.hiddenOnly=false] - When true, returns only soft-deleted (manually_deleted = 1) listings.
 * @returns {{ totalNumber:number, page:number, result:Object[] }}
 */
export const queryListings = ({
  pageSize = 50,
  page = 1,
  activityFilter,
  jobNameFilter,
  jobIdFilter,
  providerFilter,
  statusFilter,
  freeTextFilter,
  sortField = null,
  sortDir = 'asc',
  createdAfter = null,
  createdBefore = null,
  minPrice = null,
  maxPrice = null,
  hiddenOnly = false,
} = {}) => {
  // sanitize inputs
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.min(1000, Math.floor(pageSize)) : 50;
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const offset = (safePage - 1) * safePageSize;

  // build WHERE filter across common text columns
  const whereParts = [];
  const params = { limit: safePageSize, offset };
  if (freeTextFilter && String(freeTextFilter).trim().length > 0) {
    params.filter = `%${String(freeTextFilter).trim()}%`;
    whereParts.push(
      `(l.title LIKE @filter OR l.address LIKE @filter OR l.provider LIKE @filter OR l.link LIKE @filter)`,
    );
  }
  // activityFilter: when true -> only active listings (is_active = 1), false -> only inactive
  if (activityFilter === true) {
    whereParts.push('(l.is_active = 1)');
  } else if (activityFilter === false) {
    whereParts.push('(l.is_active = 0)');
  }
  // Prefer filtering by job id when provided (unambiguous and robust)
  if (jobIdFilter && String(jobIdFilter).trim().length > 0) {
    params.jobId = String(jobIdFilter).trim();
    whereParts.push('(l.job_id = @jobId)');
  } else if (jobNameFilter && String(jobNameFilter).trim().length > 0) {
    // Fallback to exact job name match
    params.jobName = String(jobNameFilter).trim();
    whereParts.push('(j.name = @jobName)');
  }
  // providerFilter: when provided as string (assumed provider name), filter listings where provider equals that name (exact match)
  if (providerFilter && String(providerFilter).trim().length > 0) {
    params.providerName = String(providerFilter).trim();
    whereParts.push('(l.provider = @providerName)');
  }
  // statusFilter: 'applied'|'rejected'|'accepted' -> equality on JSON status field; 'none' -> NULL.
  // The status column is a JSON payload `{ status, setAt }`, so we extract the inner
  // status string for comparison instead of matching the raw text.
  if (statusFilter === 'none') {
    whereParts.push('(l.status IS NULL)');
  } else if (
    typeof statusFilter === 'string' &&
    ['applied', 'rejected', 'accepted'].includes(statusFilter.toLowerCase())
  ) {
    params.statusValue = statusFilter.toLowerCase();
    whereParts.push(`(json_extract(l.status, '$.status') = @statusValue)`);
  }
  // Time range filters (unix timestamps in milliseconds)
  if (Number.isFinite(createdAfter) && createdAfter > 0) {
    params.createdAfter = createdAfter;
    whereParts.push('(l.created_at >= @createdAfter)');
  }
  if (Number.isFinite(createdBefore) && createdBefore > 0) {
    params.createdBefore = createdBefore;
    whereParts.push('(l.created_at <= @createdBefore)');
  }
  // Price range filters
  if (Number.isFinite(minPrice) && minPrice >= 0) {
    params.minPrice = minPrice;
    whereParts.push('(l.price >= @minPrice)');
  }
  if (Number.isFinite(maxPrice) && maxPrice >= 0) {
    params.maxPrice = maxPrice;
    whereParts.push('(l.price <= @maxPrice)');
  }

  // Build whereSql: in normal mode hide soft-deleted; in hiddenOnly mode show only soft-deleted.
  whereParts.push(hiddenOnly ? '(l.manually_deleted = 1)' : '(l.manually_deleted = 0)');

  const whereSqlWithAlias = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  // whitelist sortable fields to avoid SQL injection; map to fully-qualified expressions
  const sortableMap = {
    created_at: 'l.created_at',
    price: 'l.price',
    size: 'l.size',
    provider: 'l.provider',
    title: 'l.title',
    job_name: 'j.name',
    is_active: 'l.is_active',
  };
  const safeSortExpr = sortField && sortableMap[sortField] ? sortableMap[sortField] : null;
  const safeSortDir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderSqlWithAlias = safeSortExpr ? `ORDER BY ${safeSortExpr} ${safeSortDir}` : 'ORDER BY l.created_at DESC';

  // count total with same WHERE
  const countRow = SqliteConnection.query(
    `SELECT COUNT(1) as cnt
     FROM listings l
            LEFT JOIN jobs j ON j.id = l.job_id
       ${whereSqlWithAlias}`,
    params,
  );
  const totalNumber = countRow?.[0]?.cnt ?? 0;

  // fetch page
  const rows = SqliteConnection.query(
    `SELECT l.*, t.full_text AS description,
            j.name AS job_name
     FROM listings l
            LEFT JOIN listing_texts t ON t.listing_id = l.id
            LEFT JOIN jobs j ON j.id = l.job_id
       ${whereSqlWithAlias}
         ${orderSqlWithAlias}
     LIMIT @limit OFFSET @offset`,
    params,
  );

  return { totalNumber, page: safePage, result: rows.map(parseListingStatus) };
};

/**
 * Delete all listings for a given job id.
 *
 * @param {string} jobId - The job identifier whose listings should be removed.
 * @param {boolean} [hardDelete=false] - Whether to hard delete from DB or just mark as deleted.
 * @returns {any} The result from SqliteConnection.execute.
 */
export const deleteListingsByJobId = (jobId, hardDelete = false) => {
  if (!jobId) return;
  if (hardDelete) {
    return SqliteConnection.execute(
      `DELETE FROM listings
       WHERE job_id = @jobId`,
      { jobId },
    );
  }
  return SqliteConnection.execute(
    `UPDATE listings
     SET manually_deleted = 1
     WHERE job_id = @jobId`,
    { jobId },
  );
};

/**
 * Delete listings by a list of listing IDs (the nanoid primary key stored in the `id` column).
 * Used by API routes that receive row IDs from the client.
 *
 * @param {string[]} ids - Array of DB row IDs to delete.
 * @param {boolean} [hardDelete=false] - Whether to hard delete from DB or just mark as deleted.
 * @returns {any} The result from SqliteConnection.execute.
 */
export const deleteListingsById = (ids, hardDelete = false) => {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  if (hardDelete) {
    return SqliteConnection.execute(
      `DELETE FROM listings
       WHERE id IN (${placeholders})`,
      ids,
    );
  }
  return SqliteConnection.execute(
    `UPDATE listings
     SET manually_deleted = 1
     WHERE id IN (${placeholders})`,
    ids,
  );
};

/**
 * Restore a user-deleted listing. Pipeline-filtered listings keep their
 * `hidden_reason` and are intentionally not restorable into the active set.
 *
 * @param {string[]} ids - Array of DB row IDs to restore.
 * @returns {any} The result from SqliteConnection.execute.
 */
export const restoreListingsById = (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  return SqliteConnection.execute(
    `UPDATE listings
     SET manually_deleted = 0
     WHERE id IN (${placeholders})
       AND hidden_reason IS NULL`,
    ids,
  );
};

/**
 * Return listings with geocoordinates for the map view, with optional filtering.
 *
 * @param {Object} params
 * @param {string} [params.jobId]
 * @returns {{listings: Object[]}} Object containing listings.
 */
export const getListingsForMap = ({ jobId } = {}) => {
  const baseWhereParts = [
    'l.latitude IS NOT NULL',
    'l.longitude IS NOT NULL',
    'l.latitude != -1',
    'l.longitude != -1',
    'l.is_active = 1',
    'l.manually_deleted = 0',
  ];
  const params = {};

  if (jobId) {
    params.jobId = jobId;
    baseWhereParts.push('l.job_id = @jobId');
  }

  const wherePartsForListings = [...baseWhereParts];

  const listings = SqliteConnection.query(
    `SELECT l.*, j.name AS job_name,
            ridge.fair_price_per_sqm AS ridge_fair_price_per_sqm,
            ridge.delta_percent AS ridge_delta_percent,
            ridge.fair_lo_price_per_sqm AS ridge_fair_lo_price_per_sqm,
            ridge.fair_hi_price_per_sqm AS ridge_fair_hi_price_per_sqm,
            ridge.comps_500m AS ridge_comps_500m,
            gbm.fair_price_per_sqm AS gbm_fair_price_per_sqm,
            gbm.delta_percent AS gbm_delta_percent,
            gbm.fair_lo_price_per_sqm AS gbm_fair_lo_price_per_sqm,
            gbm.fair_hi_price_per_sqm AS gbm_fair_hi_price_per_sqm
     FROM listings l
     LEFT JOIN jobs j ON j.id = l.job_id
     LEFT JOIN homeserver_listing_model_scores ridge
       ON ridge.listing_id = l.id AND ridge.model_family = 'ridge'
     LEFT JOIN homeserver_listing_model_scores gbm
       ON gbm.listing_id = l.id AND gbm.model_family = 'gbm'
     WHERE ${wherePartsForListings.join(' AND ')}`,
    params,
  );

  return {
    listings,
  };
};

/**
 * Return a single listing by id.
 *
 * @param {string} id
 * @returns {Object|null}
 */
export const getListingById = (id) => {
  return parseListingStatus(
    SqliteConnection.query(
      `SELECT l.*, t.full_text AS description, j.name AS job_name
     FROM listings l
     LEFT JOIN listing_texts t ON t.listing_id = l.id
     LEFT JOIN jobs j ON j.id = l.job_id
     WHERE l.id = @id AND l.manually_deleted = 0`,
      { id },
    )[0] || null,
  );
};

/**
 * Set or clear the notes attached to a single listing.
 *
 * Empty strings are normalized to NULL so the DB doesn't keep meaningless
 * whitespace and queries can filter "has notes" with a simple IS NOT NULL.
 *
 * @param {string} id - The listing ID.
 * @param {string|null} notes - The note text to store, or null/empty to clear.
 * @returns {number} Number of rows affected (0 if listing not found).
 */
export const setListingNotes = (id, notes) => {
  if (!id) return 0;
  const trimmed = typeof notes === 'string' ? notes.trim() : null;
  const value = trimmed && trimmed.length > 0 ? trimmed : null;
  const res = SqliteConnection.execute(`UPDATE listings SET notes = @notes WHERE id = @id`, {
    id,
    notes: value,
  });
  return res?.changes ?? 0;
};

/**
 * Set or clear the status of a single listing.
 *
 * The status column stores a JSON payload `{ status, setAt }` so consumers
 * can show both the user's decision and when it was made. Passing `null`
 * clears the column.
 *
 * @param {string} id - The listing ID.
 * @param {('applied'|'rejected'|'accepted'|null)} status - New status, or null to clear.
 * @returns {number} Number of rows affected (0 if listing not found).
 */
export const setListingStatus = (id, status) => {
  if (!id) return 0;
  const allowed = ['applied', 'rejected', 'accepted'];
  const normalized = status == null ? null : String(status).toLowerCase();
  if (normalized != null && !allowed.includes(normalized)) {
    throw new Error(`Invalid listing status: ${status}`);
  }
  const payload = normalized == null ? null : JSON.stringify({ status: normalized, setAt: Date.now() });
  const res = SqliteConnection.execute(`UPDATE listings SET status = @status WHERE id = @id`, {
    id,
    status: payload,
  });
  return res?.changes ?? 0;
};
