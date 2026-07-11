/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Cross-portal duplicate suppression for notifying jobs.
 *
 * Runs in the pipeline after save and before notify: a freshly saved listing
 * is suppressed (soft-hidden via deleteListingsById + dropped from the
 * notification batch) when a VISIBLE listing of a notifying job from the
 * last 7 days already covers the same flat. "Same flat" means same link, or
 * same geocoded point where BOTH geocodes are house- or street-level
 * accuracy; in both cases the size must match exactly and the price must be
 * within ±2%.
 *
 * Shadow jobs (no notification adapters) never suppress and are never
 * matched against: their rows are hidden and were never notified, so they
 * must not swallow the first real notification of a flat.
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { deleteListingsById } from '../storage/listingsStorage.js';
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

function findDuplicate(db, listing) {
  const price = Number(listing.price);
  const size = Number(listing.size);
  // Without a comparable size and price the match would be coordinates-only,
  // which merges distinct flats in the same building/street — skip instead.
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) return null;

  const lat = Number(listing.latitude);
  const lng = Number(listing.longitude);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && lat !== -1 && lng !== -1;
  const coordsTrusted = hasCoords && TRUSTED_ACCURACIES.has(geocodeAccuracy(db, listing.address));

  const candidates = db
    .prepare(
      `
      SELECT l.id, l.job_id, l.provider, l.link, l.price, l.address
      FROM listings l
      JOIN jobs j ON j.id = l.job_id
      WHERE l.id != @id
        AND l.manually_deleted = 0
        AND l.created_at >= @cutoff
        AND json_array_length(j.notification_adapter) > 0
        AND l.size = @size
        AND (
          (@link != '' AND l.link = @link)
          OR (
            @coordsTrusted = 1
            AND ABS(l.latitude - @lat) < @eps
            AND ABS(l.longitude - @lng) < @eps
          )
        )
      `,
    )
    .all({
      id: String(listing.id ?? ''),
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

/**
 * Suppress freshly saved listings that duplicate a recently notified flat on
 * another portal or job. Fails open: any error keeps the listing.
 *
 * @param {object[]} listings freshly saved listings of the current run
 * @param {{providerId: string, notificationAdapters: object[]}} options
 * @returns {object[]} listings that are not cross-portal duplicates
 */
export function crossPortalDedupe(listings, { providerId, notificationAdapters }) {
  if (!Array.isArray(listings) || listings.length === 0) return listings;
  // Shadow jobs: keep everything — their whole point is the unfiltered corpus.
  if (!Array.isArray(notificationAdapters) || notificationAdapters.length === 0) return listings;

  let db;
  try {
    db = SqliteConnection.getConnection();
    if (!SqliteConnection.tableExists('homeserver_geocode_cache')) return listings;
  } catch {
    return listings; // fail open: a broken dedupe must never eat notifications
  }

  const kept = [];
  const suppressedIds = [];
  for (const listing of listings) {
    let match = null;
    try {
      match = findDuplicate(db, listing);
    } catch (error) {
      logger.warn(`cross-portal dedupe check failed; keeping listing '${listing.title}'`, error);
    }
    if (match) {
      suppressedIds.push(listing.id);
      logger.info(
        `Suppressed cross-portal duplicate '${listing.title}' (${providerId}, ${listing.link}) — ` +
          `already covered by ${match.provider} listing ${match.link} (job ${match.job_id})`,
      );
    } else {
      kept.push(listing);
    }
  }
  if (suppressedIds.length > 0) {
    deleteListingsById(suppressedIds);
  }
  return kept;
}
