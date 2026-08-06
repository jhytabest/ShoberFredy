/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { tableExists } from '../../../../shared/sqlite.js';
import { finiteNumber } from '../../../../shared/values.js';
import { normalizeAddress, addressKey } from '../../../geocoding/address.js';
import { hasUsableCoordinates } from '../../geo.js';
import { addHeader, metric } from '../promText.js';
import { ACCEPTED_SQL } from '../../../pipeline/terminalVerdict.js';

// Trimmed to the four series the dashboard actually plots. Inventory counts,
// price quantiles, geocode quality, job freshness and the rest had no consumer;
// /health and `yarn maintenance status` answer those on demand.
export function collectListingInventory(lines, context) {
  const { db } = context;
  const cacheByAddress = getGeocodeCache(db);
  const listings = getListings(db).map((listing) => enrichListing(listing, cacheByAddress));
  const cleaned = listings.filter((listing) => listing.cleaned);
  const visibleCleaned = cleaned.filter((listing) => !listing.isHidden);
  const activeCleaned = cleaned.filter((listing) => listing.isActive && !listing.isHidden);

  emitCleanedMarketMetrics(lines, cleaned, visibleCleaned, activeCleaned);
  emitFreshnessMetrics(lines, visibleCleaned);
  emitDailyProviderMetrics(lines, db);
  emitPriceCutMetrics(lines, db);
}

function getListings(db) {
  if (!tableExists(db, 'listings')) return [];
  return db
    .prepare(
      `
      SELECT
        id,
        created_at,
        provider,
        price,
        size,
        address,
        state,
        ${ACCEPTED_SQL('listings')} AS accepted,
        latitude,
        longitude
      FROM listings
      `,
    )
    .all();
}

function getGeocodeCache(db) {
  if (!tableExists(db, 'homeserver_geocode_cache')) return new Map();

  return new Map(
    db
      .prepare(
        `
        SELECT address_key, status, accuracy
        FROM homeserver_geocode_cache
        `,
      )
      .all()
      .map((row) => [row.address_key, row]),
  );
}

function enrichListing(row, cacheByAddress) {
  const price = finiteNumber(row.price);
  const size = finiteNumber(row.size);
  const hasCoordinates = hasUsableCoordinates(row.latitude, row.longitude);
  const address = normalizeAddress(row.address);
  const cache = cacheByAddress.get(addressKey(address)) || null;
  const pricePerSqm = price && size ? price / size : null;
  const cleaned =
    price != null &&
    size != null &&
    price > 0 &&
    size >= 10 &&
    size <= 400 &&
    pricePerSqm != null &&
    pricePerSqm >= 3 &&
    pricePerSqm <= 150 &&
    address.length > 0 &&
    hasCoordinates;

  return {
    ...row,
    price,
    size,
    pricePerSqm,
    address,
    isActive: row.state === 'active',
    isHidden: !row.accepted,
    hasCoordinates,
    cleaned,
    geocodeQuality: cache?.status === 'ok' ? cache.accuracy : cache?.status || inferGeocodeQuality(address),
  };
}

function inferGeocodeQuality(address) {
  if (/\b\d{1,4}\s?[a-z]?\b.*\b\d{5}\b/.test(address) || /\b\d{5}\b.*\b\d{1,4}\s?[a-z]?\b/.test(address)) {
    return 'address_like';
  }
  if (/\b\d{5}\b/.test(address)) return 'postcode_like';
  return 'area_like';
}

function emitCleanedMarketMetrics(lines, cleaned, visibleCleaned, activeCleaned) {
  addHeader(lines, 'fredy_market_cleaned_listings', 'gauge', 'Cleaned listings eligible for market analysis.');
  metric(lines, 'fredy_market_cleaned_listings', cleaned.length, { scope: 'all_training' });
  metric(lines, 'fredy_market_cleaned_listings', visibleCleaned.length, { scope: 'all_visible' });
  metric(lines, 'fredy_market_cleaned_listings', activeCleaned.length, { scope: 'active_visible' });
}

function emitFreshnessMetrics(lines, cleaned) {
  const now = Date.now();
  addHeader(
    lines,
    'fredy_market_new_listings',
    'gauge',
    'Cleaned visible listings created within a rolling time window.',
  );
  for (const window of [
    ['1h', 60 * 60 * 1000],
    ['1d', 24 * 60 * 60 * 1000],
    ['7d', 7 * 24 * 60 * 60 * 1000],
    ['30d', 30 * 24 * 60 * 60 * 1000],
  ]) {
    metric(
      lines,
      'fredy_market_new_listings',
      cleaned.filter((row) => Number.isFinite(row.created_at) && now - row.created_at <= window[1]).length,
      { window: window[0] },
    );
  }
}

function emitDailyProviderMetrics(lines, db) {
  if (!tableExists(db, 'jobs')) return;
  const rows = db
    .prepare(
      `
      SELECT date(l.created_at / 1000, 'unixepoch') AS date, l.provider, count(*) AS n
      FROM listings l
      WHERE      EXISTS (
        SELECT 1 FROM listing_verdicts v JOIN jobs j ON j.id = v.job_id
        WHERE v.listing_id = l.id AND json_array_length(j.notification_adapter) > 0
      )
        AND l.created_at >= (strftime('%s', 'now') - 45 * 86400) * 1000
      GROUP BY 1, 2
      `,
    )
    .all();
  addHeader(
    lines,
    'fredy_market_daily_listings_by_provider',
    'gauge',
    'Main-job listings first seen per day and provider (scraper health funnel).',
  );
  for (const row of rows) {
    metric(lines, 'fredy_market_daily_listings_by_provider', row.n, { date: row.date, provider: row.provider });
  }
}

function emitPriceCutMetrics(lines, db) {
  if (!tableExists(db, 'jobs')) return;
  const cuts = db
    .prepare(
      `
      WITH versions AS (
        SELECT l.link, l.title, l.price, l.created_at,
               first_value(l.price) OVER w AS first_price,
               last_value(l.price) OVER w AS last_price,
               max(l.created_at) OVER (PARTITION BY l.link) AS last_seen,
               count(*) OVER (PARTITION BY l.link) AS versions
        FROM listings l
        WHERE EXISTS (
            SELECT 1 FROM listing_verdicts v JOIN jobs j ON j.id = v.job_id
            WHERE v.listing_id = l.id AND json_array_length(j.notification_adapter) > 0
          )
          AND l.link IS NOT NULL AND l.link != '' AND l.price > 0
        WINDOW w AS (PARTITION BY l.link ORDER BY l.created_at
                     ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
      )
      SELECT link, title, first_price, last_price, last_seen,
             100.0 * (last_price - first_price) / first_price AS cut_percent
      FROM versions
      WHERE versions > 1 AND last_price < first_price
      GROUP BY link
      `,
    )
    .all();

  const now = Date.now();
  addHeader(
    lines,
    'fredy_market_price_cuts',
    'gauge',
    'Main-job listings whose latest price is below their first price, within a rolling window of the latest version.',
  );
  for (const [window, windowMs] of [
    ['7d', 7 * 24 * 60 * 60 * 1000],
    ['30d', 30 * 24 * 60 * 60 * 1000],
  ]) {
    metric(lines, 'fredy_market_price_cuts', cuts.filter((cut) => now - cut.last_seen <= windowMs).length, { window });
  }
}
