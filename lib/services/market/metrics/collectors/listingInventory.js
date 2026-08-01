/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Listing inventory: how many listings exist, how many are usable for market
 * analysis, how fresh they are, how well they are geocoded, and whether the
 * scrapers are still delivering.
 *
 * The "cleaned" predicate below is the exporter's own, deliberately looser
 * than the training corpus (lib/services/market/corpus.js): this collector
 * answers "does the data look sane" for every listing, including the ones the
 * corpus rejects on purpose (warm rents, furnished flats, WG rooms). Comparing
 * the two counts is how a data-quality regression becomes visible.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tableExists } from '../../../../shared/sqlite.js';
import { finiteNumber } from '../../../../shared/values.js';
import { normalizeAddress, addressKey } from '../../../geocoding/address.js';
import { hasUsableCoordinates } from '../../geo.js';
import { quantile } from '../../stats.js';
import { addHeader, emitQuantiles, groupBy, metric, numberLabel, ratio, shortenLabel } from '../promText.js';

const STALE_JOB_THRESHOLD_SECONDS = 7200;

/**
 * @param {string[]} lines
 * @param {{db: import('better-sqlite3').Database}} context
 */
export function collectListingInventory(lines, context) {
  const { db } = context;
  const cacheByAddress = getGeocodeCache(db);
  const listings = getListings(db).map((listing) => enrichListing(listing, cacheByAddress));
  const cleaned = listings.filter((listing) => listing.cleaned);
  const visibleCleaned = cleaned.filter((listing) => !listing.isHidden);
  const activeCleaned = cleaned.filter((listing) => listing.isActive && !listing.isHidden);

  emitInventoryMetrics(lines, listings);
  emitCleanedMarketMetrics(lines, cleaned, visibleCleaned, activeCleaned);
  emitFreshnessMetrics(lines, visibleCleaned);
  emitGeocodeMetrics(lines, listings);
  emitOperationalMetrics(lines, db, listings);
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
        EXISTS (SELECT 1 FROM listing_verdicts v
                 WHERE v.listing_id = listings.id AND v.verdict = 'accepted') AS accepted,
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

/*
 * Fallback precision when the address never reached the geocode cache: read it
 * off the address text itself, so a listing is never silently bucketed as
 * "well located" just because nothing looked it up.
 */
function inferGeocodeQuality(address) {
  if (/\b\d{1,4}\s?[a-z]?\b.*\b\d{5}\b/.test(address) || /\b\d{5}\b.*\b\d{1,4}\s?[a-z]?\b/.test(address)) {
    return 'address_like';
  }
  if (/\b\d{5}\b/.test(address)) return 'postcode_like';
  return 'area_like';
}

function emitInventoryMetrics(lines, listings) {
  addHeader(
    lines,
    'fredy_listings_total',
    'gauge',
    'Listings by visibility, activity, and cleaned market-model eligibility.',
  );
  for (const [key, rows] of groupBy(listings, (row) =>
    JSON.stringify({
      visibility: row.isHidden ? 'hidden' : 'visible',
      activity: row.isActive ? 'active' : 'inactive',
      cleaned: row.cleaned ? 'true' : 'false',
    }),
  )) {
    metric(lines, 'fredy_listings_total', rows.length, JSON.parse(key));
  }

  addHeader(lines, 'fredy_market_cleaned_ratio', 'gauge', 'Share of all listings eligible for the market model.');
  metric(lines, 'fredy_market_cleaned_ratio', ratio(listings.filter((row) => row.cleaned).length, listings.length));
}

function emitCleanedMarketMetrics(lines, cleaned, visibleCleaned, activeCleaned) {
  addHeader(lines, 'fredy_market_cleaned_listings', 'gauge', 'Cleaned listings eligible for market analysis.');
  metric(lines, 'fredy_market_cleaned_listings', cleaned.length, { scope: 'all_training' });
  metric(lines, 'fredy_market_cleaned_listings', visibleCleaned.length, { scope: 'all_visible' });
  metric(lines, 'fredy_market_cleaned_listings', activeCleaned.length, { scope: 'active_visible' });

  addHeader(lines, 'fredy_market_price_eur', 'gauge', 'Cleaned listing monthly price quantiles in EUR.');
  emitQuantiles(
    lines,
    'fredy_market_price_eur',
    cleaned.map((row) => row.price),
  );

  addHeader(
    lines,
    'fredy_market_price_per_sqm_eur',
    'gauge',
    'Cleaned listing monthly price per square meter quantiles in EUR.',
  );
  emitQuantiles(
    lines,
    'fredy_market_price_per_sqm_eur',
    cleaned.map((row) => row.pricePerSqm),
  );

  const medianPpsqm = quantile(
    cleaned.map((row) => row.pricePerSqm),
    0.5,
  );
  const activeMedianPpsqm = quantile(
    activeCleaned.map((row) => row.pricePerSqm),
    0.5,
  );

  addHeader(
    lines,
    'fredy_market_pressure_index',
    'gauge',
    'Active cleaned median EUR per square meter divided by all cleaned median EUR per square meter.',
  );
  metric(lines, 'fredy_market_pressure_index', medianPpsqm ? activeMedianPpsqm / medianPpsqm : 0);
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

function emitGeocodeMetrics(lines, listings) {
  addHeader(
    lines,
    'fredy_market_geocode_quality_listings',
    'gauge',
    'Listings by Google geocode cache accuracy or address-derived precision fallback.',
  );
  for (const [quality, rows] of groupBy(listings, (row) => row.geocodeQuality)) {
    metric(lines, 'fredy_market_geocode_quality_listings', rows.length, { quality });
  }
}

function emitOperationalMetrics(lines, db, listings) {
  const now = Date.now();

  if (tableExists(db, 'jobs')) {
    const jobs = db
      .prepare(`SELECT id, name, coalesce(enabled, 0) AS enabled, coalesce(last_run_at, 0) AS last_run_at FROM jobs`)
      .all();
    const enabledJobs = jobs.filter((job) => job.enabled === 1);
    const enabledAges = enabledJobs.map((job) => Math.max(0, Math.floor((now - job.last_run_at) / 1000)));

    addHeader(lines, 'fredy_jobs_enabled', 'gauge', 'Enabled scrape jobs.');
    metric(lines, 'fredy_jobs_enabled', enabledAges.length);
    addHeader(lines, 'fredy_job_age_seconds', 'gauge', 'Age of the most recent run for each enabled scrape job.');
    for (const job of enabledJobs) {
      metric(lines, 'fredy_job_age_seconds', Math.max(0, Math.floor((now - job.last_run_at) / 1000)), {
        job_id: job.id,
        job_name: shortenLabel(job.name || job.id, 60),
      });
    }
    addHeader(lines, 'fredy_jobs_stale', 'gauge', 'Enabled jobs whose last run is older than the staleness threshold.');
    metric(lines, 'fredy_jobs_stale', enabledAges.filter((age) => age > STALE_JOB_THRESHOLD_SECONDS).length, {
      threshold_seconds: String(STALE_JOB_THRESHOLD_SECONDS),
    });
    if (enabledAges.length > 0) {
      addHeader(lines, 'fredy_job_max_age_seconds', 'gauge', 'Age of the least recently run enabled job.');
      metric(lines, 'fredy_job_max_age_seconds', Math.max(...enabledAges));
    }
  }

  const newestListing = listings.reduce(
    (newest, row) => (Number.isFinite(row.created_at) && row.created_at > newest ? row.created_at : newest),
    0,
  );
  if (newestListing > 0) {
    addHeader(lines, 'fredy_newest_listing_age_seconds', 'gauge', 'Age of the most recently ingested listing.');
    metric(lines, 'fredy_newest_listing_age_seconds', Math.max(0, Math.floor((now - newestListing) / 1000)));
  }

  emitProviderFreshnessMetrics(lines, db, now);

  addHeader(lines, 'fredy_listings_missing_coordinates', 'gauge', 'Listings without valid coordinates by scope.');
  const visible = listings.filter((row) => !row.isHidden);
  const activeVisible = visible.filter((row) => row.isActive);
  metric(lines, 'fredy_listings_missing_coordinates', visible.filter((row) => !row.hasCoordinates).length, {
    scope: 'visible',
  });
  metric(lines, 'fredy_listings_missing_coordinates', activeVisible.filter((row) => !row.hasCoordinates).length, {
    scope: 'active_visible',
  });

  if (tableExists(db, 'homeserver_geocode_cache')) {
    addHeader(lines, 'fredy_geocode_cache_entries', 'gauge', 'Geocode cache entries by status.');
    const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM homeserver_geocode_cache GROUP BY status`).all();
    for (const row of rows) {
      metric(lines, 'fredy_geocode_cache_entries', row.n, { status: row.status });
    }
  }
}

/*
 * Restricted to providers this build can actually scrape. Retired providers
 * keep their historical listings forever, so grouping over the whole table
 * published series whose age only ever grew — noise that looks like an outage
 * but describes a provider that was removed on purpose.
 */
function emitProviderFreshnessMetrics(lines, db, now) {
  if (!tableExists(db, 'listings')) return;
  const activeProviders = installedProviderIds();
  const providerRows = db
    .prepare(
      `SELECT provider, MAX(created_at) AS newest
       FROM listings
       WHERE provider IS NOT NULL AND provider != ''
       GROUP BY provider`,
    )
    .all()
    .filter((row) => activeProviders.has(row.provider));
  addHeader(lines, 'fredy_provider_newest_listing_age_seconds', 'gauge', 'Age of the newest listing by provider.');
  for (const row of providerRows) {
    metric(lines, 'fredy_provider_newest_listing_age_seconds', Math.max(0, (now - row.newest) / 1000), {
      provider: row.provider,
    });
  }
}

/*
 * Daily scrape volume per provider over the last 45 days, main (notifying)
 * jobs only — the scraper-health funnel.
 */
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

/*
 * Price-cut tracker: a portal edit re-inserts the same link with a new hash,
 * so "same link, lower latest price" is a repricing event — a motivated
 * landlord and often a stronger signal than the model delta.
 */
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

  addHeader(
    lines,
    'fredy_market_top_price_cut',
    'gauge',
    'Largest recent price cuts (value = cut in percent, negative).',
  );
  const top = cuts
    .filter((cut) => now - cut.last_seen <= 7 * 24 * 60 * 60 * 1000)
    .sort((a, b) => a.cut_percent - b.cut_percent)
    .slice(0, 5);
  top.forEach((cut, index) => {
    metric(lines, 'fredy_market_top_price_cut', cut.cut_percent, {
      rank: String(index + 1),
      title: shortenLabel(cut.title, 60),
      link: cut.link,
      first_price: numberLabel(cut.first_price),
      last_price: numberLabel(cut.last_price),
    });
  });
}

let cachedProviderIds = null;

/**
 * Provider ids this build can scrape, taken from the provider directory.
 * Each provider module is named after its own `metaInformation.id`, which is
 * the value stored in `listings.provider`. Resolved once per process.
 * @returns {Set<string>}
 */
function installedProviderIds() {
  if (cachedProviderIds) return cachedProviderIds;
  const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'provider');
  try {
    cachedProviderIds = new Set(
      fs
        .readdirSync(directory)
        .filter((file) => file.endsWith('.js'))
        .map((file) => file.slice(0, -3)),
    );
  } catch {
    // Unreadable provider directory must not take the exporter down; fall back
    // to publishing every provider rather than none.
    cachedProviderIds = null;
    return new Set(['immoscout', 'immowelt', 'kleinanzeigen', 'wgGesucht']);
  }
  return cachedProviderIds;
}
