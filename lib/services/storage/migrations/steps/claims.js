/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The claim table: one row per fact a listing asserts about itself.
 *
 * This is the storage half of lib/services/listings/claims.js, which holds the
 * only definition of what those facts are. The backfill deliberately calls the
 * same generator the pipeline calls at write time — a claim recorded by the
 * migration and a claim recorded by the finalizer have to be byte-identical, or
 * history stops resolving against new arrivals and retiring the nightly sweep
 * would lose exactly the merges it used to catch.
 */

import { canonicalUrl, claimsForListing, geocodeAccuracyFor, recordClaims } from '../../../listings/claims.js';
import { tableExists } from '../../../../shared/sqlite.js';

/**
 * @param {import('better-sqlite3').Database} db
 */
export function migrateClaims(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_claims (
      claim TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listing_claims_listing ON listing_claims(listing_id);
  `);
  // The whole schema file re-runs on every checksum change, so the backfill has
  // to be gated on something. Emptiness is the honest test: once a single claim
  // exists the runtime owns the table, and re-deriving history would reassign
  // ownership of claims the pipeline has already resolved listings against.
  const claimed = db.prepare('SELECT COUNT(*) FROM listing_claims').pluck().get();
  if (claimed > 0) return;
  backfill(db);
}

/**
 * Derive claims for every stored listing from what the database already holds.
 *
 * Oldest first: `claim` is a primary key, so the first listing to assert a fact
 * owns it, and the row that saw the ad first is the one an operator expects to
 * find when they ask which listing a claim belongs to.
 *
 * @param {import('better-sqlite3').Database} db
 */
function backfill(db) {
  if (!tableExists(db, 'listings')) return;
  const now = Date.now();
  const identities = groupBy(sourceIdentities(db), 'listing_id');
  const images = groupBy(imageHashes(db), 'listing_id');
  const listings = db.prepare('SELECT * FROM listings ORDER BY created_at ASC, id ASC').all();
  for (const listing of listings) {
    // Only the sources that actually name this listing's own primary URL become
    // identity claims. The retired batch sweep reassigned every absorbed row's
    // listing_sources to its survivor, so history contains rows carrying dozens
    // of source keys for unrelated flats — one wg-gesucht listing here holds 47.
    // Backfilling those as identity would hand it ownership of 47 URL and expose-id
    // claims and merge 34 different apartments into one cluster the first time
    // any of them was rediscovered. The listing's own link is the safe anchor;
    // cross-portal identity is what the resemblance kinds are for.
    const primary = canonicalUrl(listing.link);
    listing.sourceIdentities = (identities.get(listing.id) || [])
      .filter((row) => canonicalUrl(row.source_url) === primary)
      .map((row) => ({ provider: row.provider, sourceKey: row.source_key, sourceUrl: row.source_url }));
    listing.imageHashes = (images.get(listing.id) || []).map((row) => row.content_hash);
    listing.geocodeAccuracy = geocodeAccuracyFor(db, listing.address);
    recordClaims(db, listing.id, claimsForListing(listing), listing.created_at || now);
  }
}

function sourceIdentities(db) {
  if (!tableExists(db, 'listing_sources')) return [];
  return db
    .prepare(
      `SELECT listing_id, provider, source_key, source_url
       FROM listing_sources
       WHERE listing_id IS NOT NULL
       ORDER BY first_seen_at ASC`,
    )
    .all();
}

function imageHashes(db) {
  if (!tableExists(db, 'listing_images')) return [];
  return db
    .prepare(
      `SELECT DISTINCT listing_id, content_hash
       FROM listing_images
       WHERE listing_id IS NOT NULL
         AND download_status = 'stored'
         AND content_hash IS NOT NULL`,
    )
    .all();
}

function groupBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row[key])) grouped.set(row[key], []);
    grouped.get(row[key]).push(row);
  }
  return grouped;
}
