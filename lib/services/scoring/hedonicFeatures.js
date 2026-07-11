/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Hedonic design vector shared by the market model (training) and the
 * notification-time scorer (inference from persisted beta). The two MUST
 * agree exactly — a listing scored at notify time uses the same features in
 * the same order as the model that produced the coefficients.
 */

export const BASELINE_SIZE_SQM = 70;
export const BASELINE_ROOMS = 2;
export const MAX_MONTH_OFFSETS = 6;

export const HEDONIC_TERMS = [
  { name: 'intercept', value: () => 1 },
  { name: 'log_size', value: (l) => Math.log(l.size / BASELINE_SIZE_SQM) },
  { name: 'rooms_dev', value: (l) => (l.rooms == null ? 0 : clamp(l.rooms, 1, 6) - BASELINE_ROOMS) },
  { name: 'rooms_missing', value: (l) => (l.rooms == null ? 1 : 0) },
  { name: 'floor_scaled', value: (l) => (l.floor == null ? 0 : clamp(l.floor, -1, 8) / 4) },
  { name: 'floor_ground', value: (l) => (l.floor === 0 ? 1 : 0) },
  { name: 'floor_missing', value: (l) => (l.floor == null ? 1 : 0) },
  { name: 'year_scaled', value: (l) => (l.buildingYear == null ? 0 : (clamp(l.buildingYear, 1870, 2026) - 1970) / 50) },
  { name: 'year_missing', value: (l) => (l.buildingYear == null ? 1 : 0) },
  { name: 'type_altbau', value: (l) => (l.propertyType === 'altbau' ? 1 : 0) },
  { name: 'type_neubau', value: (l) => (l.propertyType === 'neubau' ? 1 : 0) },
  { name: 'type_top', value: (l) => (['maisonette', 'penthouse', 'dachgeschoss'].includes(l.propertyType) ? 1 : 0) },
  { name: 'price_warm', value: (l) => (l.priceType === 'warm' ? 1 : 0) },
  { name: 'price_unknown', value: (l) => (l.priceType === 'unknown' ? 1 : 0) },
];

export const TEXT_FEATURES = [
  { name: 'balcony', patterns: [/\bbalkon\b/i, /\bbalcony\b/i] },
  { name: 'furnished', patterns: [/\bmöbliert\b/i, /\bfurnished\b/i] },
  { name: 'garden', patterns: [/\bgarten\b/i, /\bgarden\b/i] },
  { name: 'terrace', patterns: [/\bterrasse\b/i, /\bterrace\b/i] },
  { name: 'elevator', patterns: [/\baufzug\b/i, /\belevator\b/i, /\blift\b/i] },
  { name: 'fitted_kitchen', patterns: [/\beinbauküche\b/i, /\bebk\b/i, /\bfitted kitchen\b/i] },
  { name: 'renovated', patterns: [/\bsaniert\b/i, /\brenoviert\b/i, /\brenovated\b/i] },
  { name: 'quiet', patterns: [/\bruhig\b/i, /\bquiet\b/i] },
  { name: 'barrier_free', patterns: [/\bbarrierefrei\b/i, /\bbarrier[- ]free\b/i] },
];

/**
 * Boolean feature flags detected in listing text.
 * @param {string} title
 * @param {string} description
 * @param {string} address
 * @returns {Record<string, boolean>}
 */
export function textFeatureFlags(title, description, address) {
  const text = `${title || ''} ${description || ''} ${address || ''}`.toLowerCase();
  return Object.fromEntries(TEXT_FEATURES.map((feature) => [feature.name, feature.patterns.some((p) => p.test(text))]));
}

/**
 * Total dimensionality of the hedonic design vector.
 * @returns {number}
 */
export function hedonicDimensions() {
  return HEDONIC_TERMS.length + TEXT_FEATURES.length + MAX_MONTH_OFFSETS;
}

/**
 * Names of all design-vector terms, in vector order.
 * @returns {string[]}
 */
export function hedonicTermNames() {
  return [
    ...HEDONIC_TERMS.map((term) => term.name),
    ...TEXT_FEATURES.map((feature) => feature.name),
    ...Array.from({ length: MAX_MONTH_OFFSETS }, (_, index) => `month_${index + 1}`),
  ];
}

/**
 * Build the design vector for one listing.
 * @param {object} listing needs: size, rooms, floor, buildingYear,
 *   propertyType, priceType, features (from textFeatureFlags), monthOffset.
 * @returns {number[]}
 */
export function hedonicDesignVector(listing) {
  const dummies = new Array(MAX_MONTH_OFFSETS).fill(0);
  const offset = listing.monthOffset ?? 0;
  if (offset >= 1) dummies[Math.min(offset, MAX_MONTH_OFFSETS) - 1] = 1;
  return [
    ...HEDONIC_TERMS.map((term) => term.value(listing)),
    ...TEXT_FEATURES.map((feature) => (listing.features?.[feature.name] ? 1 : 0)),
    ...dummies,
  ];
}

/**
 * Dot product of two equal-length vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/**
 * Clamp value into [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
