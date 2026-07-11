/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Canonical address normalization shared by the geocoder (cache writer), the
 * market model, and the market exporter (cache readers). The geocode cache is
 * keyed by addressKey(), so every reader and writer must use this exact
 * implementation.
 */

/**
 * Collapse whitespace and trim an address string.
 * @param {string} value
 * @returns {string}
 */
export function normalizeAddress(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();
}

/**
 * Canonical cache key for an address (normalized + lowercased).
 * @param {string} value
 * @returns {string}
 */
export function addressKey(value) {
  return normalizeAddress(value).toLowerCase();
}
