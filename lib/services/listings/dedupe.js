/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Unified duplicate detection, run BEFORE save: a duplicate is never stored.
 * Layers, strongest evidence first:
 *
 * 1. Same provider source key or canonical URL across one owner's jobs.
 * 2. Exact title + address + price identity.
 * 3. Two shared gallery hashes with matching size and price.
 * 4. Trusted house/street coordinates with matching size and close price.
 *
 * The legacy batch path also retains its similarity-cache and same-link
 * checks. Cross-job matching is scoped to one owner so one user's discovery
 * can never suppress another user's notification.
 *
 * Fails open: any error keeps the listing.
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { addressKey } from '../geocoding/address.js';
import { canonicalUrl } from '../pipeline/temporaryDeterministic.js';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PRICE_TOLERANCE = 0.02;
const COORD_EPSILON = 1e-5; // ~1.1 m at Berlin's latitude
const TRUSTED_ACCURACIES = new Set(['house', 'street']);

function geocodeAccuracy(db, address) {
  if (!address) return null;
  const row = db
    .prepare(`SELECT accuracy FROM homeserver_geocode_cache WHERE address_key = ? AND status = 'ok'`)
    .get(addressKey(address));
  return row ? row.accuracy : null;
}

function priceClose(a, b) {
  return Math.abs(a - b) <= PRICE_TOLERANCE * Math.max(a, b);
}

/**
 * Strongest identity layer: the same provider source key or canonical source
 * URL is always the same ad, even after a price change or historical backfill.
 * Scope across all jobs owned by the same user, never across users.
 */
function findExactSourceDuplicate(db, listing) {
  if (!tableExists(db, 'jobs') || !tableExists(db, 'listing_sources')) return null;
  const identities = (listing.sourceIdentities || [])
    .filter((identity) => identity?.provider && identity?.sourceKey)
    .map((identity) => ({ provider: identity.provider, sourceKey: identity.sourceKey }));
  const urls = unique([
    listing.link,
    ...(listing.sourceUrls || []),
    ...(listing.sourceIdentities || []).map((identity) => identity?.sourceUrl),
  ]).flatMap((url) => unique([url, canonicalUrl(url)]));
  if (!identities.length && !urls.length) return null;

  return (
    db
      .prepare(
        `SELECT DISTINCT l.id, l.job_id, l.provider, l.link, l.price, l.address
         FROM listings l
         JOIN jobs owner ON owner.id = l.job_id
         LEFT JOIN jobs incoming ON incoming.id = @jobId
         LEFT JOIN listing_sources source ON source.listing_id = l.id
         WHERE l.manually_deleted = 0
           AND l.hidden_reason IS NULL
           AND (@jobId IS NULL OR owner.user_id = incoming.user_id)
           AND (
             l.link IN (SELECT value FROM json_each(@urls))
             OR EXISTS (
               SELECT 1 FROM json_each(COALESCE(l.source_urls_json, '[]')) known
               WHERE known.value IN (SELECT value FROM json_each(@urls))
             )
             OR EXISTS (
               SELECT 1 FROM json_each(@identities) identity
               WHERE source.provider = json_extract(identity.value, '$.provider')
                 AND source.source_key = json_extract(identity.value, '$.sourceKey')
             )
           )
         ORDER BY l.is_active DESC, l.created_at ASC
         LIMIT 1`,
      )
      .get({
        jobId: listing.jobId ?? null,
        urls: JSON.stringify(urls),
        identities: JSON.stringify(identities),
      }) || null
  );
}

/**
 * Geospatial layer: a stored, visible, recent listing covers the same flat
 * when both geocodes are trustworthy and size/price agree.
 * The incoming listing is not yet saved, so no self-match is possible.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} listing
 * @returns {object|null} the covering row, or null
 */
function findStoredDuplicate(db, listing) {
  const price = Number(listing.price);
  const size = Number(listing.size);
  // Without a comparable size and price the match would be coordinates-only,
  // which merges distinct flats in the same building/street — skip instead.
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) return null;

  const lat = Number(listing.latitude);
  const lng = Number(listing.longitude);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && lat !== -1 && lng !== -1;
  const coordsTrusted = hasCoords && TRUSTED_ACCURACIES.has(geocodeAccuracy(db, listing.address));
  const hasJobs = tableExists(db, 'jobs');
  const jobsJoin = hasJobs
    ? 'JOIN jobs owner ON owner.id = l.job_id LEFT JOIN jobs incoming ON incoming.id = @jobId'
    : '';
  const ownerScope = hasJobs
    ? '(@jobId IS NULL OR owner.user_id = incoming.user_id)'
    : '(@jobId IS NULL OR l.job_id = @jobId)';
  const hiddenScope = columnExists(db, 'listings', 'hidden_reason') ? 'AND l.hidden_reason IS NULL' : '';
  const sourceLinkMatch = columnExists(db, 'listings', 'source_urls_json')
    ? `l.link = @link OR EXISTS (
         SELECT 1 FROM json_each(COALESCE(l.source_urls_json, '[]')) source
         WHERE source.value = @link
       )`
    : 'l.link = @link';

  const candidates = db
    .prepare(
      `
      SELECT l.id, l.job_id, l.provider, l.link, l.price, l.address
      FROM listings l
      ${jobsJoin}
      WHERE l.manually_deleted = 0
        ${hiddenScope}
        AND ${ownerScope}
        AND l.created_at >= @cutoff
        AND l.size = @size
        AND (
          (@link != '' AND (${sourceLinkMatch}))
          OR (
            @coordsTrusted = 1
            AND ABS(l.latitude - @lat) < @eps
            AND ABS(l.longitude - @lng) < @eps
          )
        )
      `,
    )
    .all({
      cutoff: Date.now() - WINDOW_MS,
      jobId: listing.jobId ?? null,
      size,
      link: listing.link ?? '',
      coordsTrusted: coordsTrusted ? 1 : 0,
      lat: hasCoords ? lat : null,
      lng: hasCoords ? lng : null,
      eps: COORD_EPSILON,
    });

  for (const candidate of candidates) {
    const candidatePrice = Number(candidate.price);
    if (!Number.isFinite(candidatePrice) || candidatePrice <= 0 || !priceClose(price, candidatePrice)) continue;
    if (candidate.link && listing.link && candidate.link === listing.link) return candidate;
    if (TRUSTED_ACCURACIES.has(geocodeAccuracy(db, candidate.address))) return candidate;
  }
  return null;
}

function findSemanticDuplicate(db, listing) {
  const title = String(listing.title || '').trim();
  const address = String(listing.address || '').trim();
  const price = Number(listing.price);
  if (!title || !address || !Number.isFinite(price) || price <= 0) return null;
  const hasJobs = tableExists(db, 'jobs');
  const jobsJoin = hasJobs ? 'JOIN jobs owner ON owner.id = l.job_id LEFT JOIN jobs incoming ON incoming.id = ?' : '';
  const ownerScope = hasJobs ? '(? IS NULL OR owner.user_id = incoming.user_id)' : '(? IS NULL OR l.job_id = ?)';
  const hiddenScope = columnExists(db, 'listings', 'hidden_reason') ? 'AND l.hidden_reason IS NULL' : '';
  const jobId = listing.jobId ?? null;
  const params = [jobId, jobId, Date.now() - WINDOW_MS, title, address, price];
  return db
    .prepare(
      `SELECT l.id, l.job_id, l.provider, l.link, l.price, l.address
       FROM listings l
       ${jobsJoin}
       WHERE l.manually_deleted = 0
         ${hiddenScope}
         AND ${ownerScope}
         AND l.created_at >= ?
         AND lower(trim(l.title)) = lower(trim(?))
         AND lower(trim(l.address)) = lower(trim(?))
         AND l.price = ?
       ORDER BY l.created_at ASC
       LIMIT 1`,
    )
    .get(...params);
}

/**
 * Media layer: two shared optimized image hashes plus matching size and price
 * are a strong cross-portal identity without trusting titles or addresses.
 */
function findImageDuplicate(db, listing) {
  if (!tableExists(db, 'jobs') || !tableExists(db, 'listing_images')) return null;
  const hashes = unique(listing.imageHashes || []);
  const price = Number(listing.price);
  const size = Number(listing.size);
  if (hashes.length < 2 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  const candidates = db
    .prepare(
      `SELECT l.id, l.job_id, l.provider, l.link, l.price, l.address,
              COUNT(DISTINCT image.content_hash) AS shared_images
       FROM listings l
       JOIN jobs owner ON owner.id = l.job_id
       LEFT JOIN jobs incoming ON incoming.id = @jobId
       JOIN listing_images image ON image.listing_id = l.id
       WHERE l.manually_deleted = 0
         AND l.hidden_reason IS NULL
         AND (@jobId IS NULL OR owner.user_id = incoming.user_id)
         AND l.created_at >= @cutoff
         AND l.size = @size
         AND image.content_hash IN (SELECT value FROM json_each(@hashes))
       GROUP BY l.id
       HAVING COUNT(DISTINCT image.content_hash) >= 2
       ORDER BY shared_images DESC, l.created_at ASC`,
    )
    .all({
      jobId: listing.jobId ?? null,
      cutoff: Date.now() - WINDOW_MS,
      size,
      hashes: JSON.stringify(hashes),
    });
  return (
    candidates.find((candidate) => {
      const candidatePrice = Number(candidate.price);
      return Number.isFinite(candidatePrice) && candidatePrice > 0 && priceClose(price, candidatePrice);
    }) || null
  );
}

/** Return the stored representative instead of throwing away its new source. */
export function findDuplicate(listing) {
  let db;
  try {
    db = SqliteConnection.getConnection();
  } catch {
    return null;
  }
  const exactSource = findExactSourceDuplicate(db, listing);
  if (exactSource) return exactSource;

  const price = Number(listing.price);
  const hasSemanticIdentity =
    typeof listing.title === 'string' &&
    listing.title.trim() !== '' &&
    typeof listing.address === 'string' &&
    listing.address.trim() !== '' &&
    Number.isFinite(price) &&
    price > 0;
  if (hasSemanticIdentity) {
    const semantic = findSemanticDuplicate(db, listing);
    if (semantic) return semantic;
  }
  const image = findImageDuplicate(db, listing);
  if (image) return image;
  return findStoredDuplicate(db, listing);
}

function tableExists(db, table) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
}

function columnExists(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((entry) => entry.name === column);
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}
