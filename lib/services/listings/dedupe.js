/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Unified duplicate detection, run BEFORE save: a duplicate is never stored.
 * Two checks, in order:
 *
 * 1. Similarity cache — in-memory hash of title|price|address across all
 *    jobs and providers, but only when all three LLM facts are present. A
 *    partial extraction must never collapse into a shared empty hash.
 * 2. Cross-portal database check — a VISIBLE listing from the last 7 days
 *    already covers the same flat: same link, or same geocoded point where
 *    BOTH geocodes are house-/street-level accuracy; in both cases the size
 *    must match exactly and the price must be within ±2%. A price change
 *    beyond the tolerance is a repricing event and intentionally NOT a
 *    duplicate.
 *
 * Fails open: any error keeps the listing.
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { addressKey } from '../geocoding/address.js';
import logger from '../logger.js';

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
 * Find a stored, visible, recent listing that covers the same flat.
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
      WHERE l.manually_deleted = 0
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
    // A shared link is the same ad regardless of geocode quality.
    if (candidate.link && listing.link && candidate.link === listing.link) return candidate;
    // Coordinate match: the existing listing's geocode must be trusted too.
    if (TRUSTED_ACCURACIES.has(geocodeAccuracy(db, candidate.address))) return candidate;
  }
  return null;
}

function columnExists(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((entry) => entry.name === column);
}

function findSemanticDuplicate(db, listing) {
  const title = String(listing.title || '').trim();
  const address = String(listing.address || '').trim();
  const price = Number(listing.price);
  if (!title || !address || !Number.isFinite(price) || price <= 0) return null;
  return db
    .prepare(
      `SELECT id, job_id, provider, link, price, address
       FROM listings
       WHERE manually_deleted = 0
         AND created_at >= ?
         AND lower(trim(title)) = lower(trim(?))
         AND lower(trim(address)) = lower(trim(?))
         AND price = ?
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(Date.now() - WINDOW_MS, title, address, price);
}

/** Return the stored representative instead of throwing away its new source. */
export function findDuplicate(listing, { similarityCache }) {
  let db;
  try {
    db = SqliteConnection.getConnection();
  } catch {
    return null;
  }
  const price = Number(listing.price);
  const hasSemanticIdentity =
    typeof listing.title === 'string' &&
    listing.title.trim() !== '' &&
    typeof listing.address === 'string' &&
    listing.address.trim() !== '' &&
    Number.isFinite(price) &&
    price > 0;
  if (hasSemanticIdentity && similarityCache.hasEntry(listing)) {
    const semantic = findSemanticDuplicate(db, listing);
    if (semantic) return semantic;
  }
  return findStoredDuplicate(db, listing);
}

/**
 * Drop duplicates from a batch of new listings before they are saved.
 *
 * Read-only with respect to the similarity cache: callers commit surviving
 * listings via `similarityCache.addEntry` AFTER storing them, so a retry of
 * a failed store never sees its own hash and misclassifies the listing as a
 * duplicate.
 *
 * @param {object[]} listings freshly scraped, not-yet-saved listings
 * @param {{similarityCache: {hasEntry: Function}, providerId: string}} options
 * @returns {object[]} listings that are not duplicates
 */
export function dropDuplicates(listings, { similarityCache, providerId }) {
  if (!Array.isArray(listings) || listings.length === 0) return listings;

  let db = null;
  try {
    db = SqliteConnection.getConnection();
    if (!SqliteConnection.tableExists('homeserver_geocode_cache')) db = null;
  } catch {
    db = null; // fail open: similarity check still runs, DB check skipped
  }

  return listings.filter((listing) => {
    try {
      const price = Number(listing.price);
      const hasSemanticIdentity =
        typeof listing.title === 'string' &&
        listing.title.trim() !== '' &&
        typeof listing.address === 'string' &&
        listing.address.trim() !== '' &&
        Number.isFinite(price) &&
        price > 0;
      const similar =
        hasSemanticIdentity &&
        similarityCache.hasEntry({
          title: listing.title,
          address: listing.address,
          price: listing.price,
        });
      if (similar) {
        logger.debug(`Dropping similar listing '${listing.title}' / '${listing.address}' (Provider: '${providerId}')`);
        return false;
      }

      const match = db ? findDuplicate(listing, { similarityCache }) : null;
      if (match) {
        logger.info(
          `Dropping cross-portal duplicate '${listing.title}' (${providerId}, ${listing.link}) — ` +
            `already covered by ${match.provider} listing ${match.link} (job ${match.job_id})`,
        );
        return false;
      }
      return true;
    } catch (error) {
      logger.warn(`dedupe check failed; keeping listing '${listing.title}'`, error);
      return true;
    }
  });
}
