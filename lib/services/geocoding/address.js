/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { normalizeMarket } from '../../shared/markets.js';

export function normalizeAddress(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();
}

// A bare German street name matches in a hundred towns, so the cache must be
// anchored to the city that was searched — not just the address text — or a
// row cached under one city's anchor is returned verbatim to another city's
// job. `city` is normalized the same way a job's own city becomes a market,
// so callers can pass either a raw city string or an already-resolved market.
export function addressKey(value, city = null) {
  return `${normalizeAddress(value).toLowerCase()}::${normalizeMarket(city) || ''}`;
}
