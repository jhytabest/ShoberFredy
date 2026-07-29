/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Value guards and normalisation.
 *
 * The two numeric guards are kept deliberately distinct because the difference
 * matters: a rent of 0 is not a rent, but a floor of 0 is a floor. Previously
 * five copies existed under two contracts and both wrote the same columns.
 */

/**
 * A finite number strictly greater than zero, or null. Use for rent, area and
 * room counts, where zero means "not stated".
 * @param {unknown} value
 * @returns {number|null}
 */
export function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Any finite number, or null. Use where zero and negatives are meaningful, such
 * as floor numbers and coordinates.
 * @param {unknown} value
 * @returns {number|null}
 */
export function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Case- and whitespace-normalised German text, for comparison only. NFKC folds
 * compatibility forms so that visually identical strings compare equal.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('de-DE')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * De-duplicate while preserving order, dropping falsy entries and trimming
 * strings.
 * @template T
 * @param {T[]} values
 * @returns {T[]}
 */
export function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const item = typeof value === 'string' ? value.trim() : value;
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
