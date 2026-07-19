/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { deactivateListings, getActiveOrUnknownListings } from '../storage/listingsStorage.js';
import { getProviders } from '../../utils.js';
import logger from '../../services/logger.js';

const MAX_ACTIVE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Runs the active-listing checker:
 * 1) Loads all listings with unknown or active status.
 * 2) Expires listings once they are seven days old.
 * 3) Otherwise calls the provider's `activeTester(link)` exactly once.
 * 4) Deactivates anything unavailable, except confirmed bot blocking.
 *
 * Concurrency: network-bound checks are executed with a configurable concurrency limit.
 *
 * @param {object} [opts]
 * @param {number} [opts.concurrency=4] Max number of parallel activeTester calls.
 * @returns {Promise<void>}
 */
export default async function runActiveChecker(opts = {}) {
  const { concurrency = 4 } = opts;

  const listings = getActiveOrUnknownListings();
  if (!Array.isArray(listings) || listings.length === 0) {
    logger.debug('No listings to check.');
    return;
  }

  const providers = await getProviders();
  if (!Array.isArray(providers) || providers.length === 0) {
    logger.warn('No providers available. Skipping active checks.');
    return;
  }

  // Build a map for O(1) provider lookup by id
  /** @type {Record<string, any>} */
  const providerById = Object.create(null);
  for (const p of providers) {
    const id = p?.metaInformation?.id;
    if (id) providerById[id] = p;
  }

  // Small generic mapLimit to cap concurrency without extra deps
  /**
   * @template T, R
   * @param {T[]} items
   * @param {number} limit
   * @param {(item: T, index: number) => Promise<R>} worker
   * @returns {Promise<R[]>}
   */
  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;

    async function runOne() {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = await worker(items[i], i);
        } catch (err) {
          results[i] = /** @type {any} */ (err);
        }
      }
    }

    const runners = Array.from({ length: Math.min(limit, items.length) }, runOne);
    await Promise.all(runners);
    return results;
  }

  /** @type {string[]} */
  const expiredListings = [];
  /** @type {string[]} */
  const unavailableListings = [];

  await mapLimit(listings, concurrency, async (listing) => {
    const { provider: listingProviderId, link, id, created_at: createdAt } = listing || {};
    if (id && listingAgeMs(createdAt) >= MAX_ACTIVE_AGE_MS) {
      expiredListings.push(id);
      return;
    }

    const matchedProvider = providerById[listingProviderId];
    if (!matchedProvider) {
      logger.warn('Could not find matching provider for', listingProviderId);
      return;
    }
    const tester = matchedProvider?.config?.activeTester;
    if (typeof tester !== 'function') {
      logger.warn('No activeTester configured for', listingProviderId);
      return;
    }

    // Contract: activeTester(link) returns 1 if active, 0 if inactive
    let result;
    try {
      result = await tester(link);
    } catch {
      result = -1;
    }

    if (result === 0 && id) unavailableListings.push(id);
  });

  if (expiredListings.length > 0) {
    deactivateListings(expiredListings, 'seven_day_expiry');
    logger.info(`Set ${expiredListings.length} listings inactive after seven days.`);
  }
  if (unavailableListings.length > 0) {
    deactivateListings(unavailableListings, 'provider_unreachable_or_inactive');
    logger.info(`Set ${unavailableListings.length} unreachable listings inactive.`);
  }
  if (expiredListings.length === 0 && unavailableListings.length === 0) {
    logger.debug('No listings need to be set inactive.');
  } else {
    logger.info(`Recorded ${expiredListings.length + unavailableListings.length} listing lifecycle changes.`);
  }
}

function listingAgeMs(createdAt, now = Date.now()) {
  const numeric = Number(createdAt);
  if (Number.isFinite(numeric) && numeric > 0) {
    const timestamp = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    return Math.max(0, now - timestamp);
  }
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : 0;
}
