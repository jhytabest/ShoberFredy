/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Feature builders shared by the market models (training) and the
 * notification-time scorer (inference from persisted artifacts). Trainer and
 * scorer MUST agree exactly — a listing scored at notify time uses the same
 * features in the same order as the model that produced the artifact. The
 * GBM trainer (tools/market/train_gbm.py) never builds features itself: it
 * receives the numeric matrix produced here, so feature parity across the
 * two languages is structural, not disciplined.
 *
 * Both models train on cold-equivalent rent only (see corpus.js), so there
 * are no warm/unknown price dummies anymore — just a 'price_cold_est' flag
 * marking rows whose cold rent was imputed from warm minus charges, letting
 * each model absorb any systematic imputation bias.
 */

const BASELINE_SIZE_SQM = 70;
const BASELINE_ROOMS = 2;
export const MAX_MONTH_OFFSETS = 6;

const HEDONIC_TERMS = [
  { name: 'intercept', value: () => 1 },
  { name: 'log_size', value: (l) => Math.log(l.size / BASELINE_SIZE_SQM) },
  { name: 'rooms_dev', value: (l) => (l.rooms == null ? 0 : clamp(l.rooms, 1, 6) - BASELINE_ROOMS) },
  { name: 'rooms_missing', value: (l) => (l.rooms == null ? 1 : 0) },
  { name: 'bedrooms_dev', value: (l) => (l.bedrooms == null ? 0 : clamp(l.bedrooms, 0, 6) - 1) },
  { name: 'bedrooms_missing', value: (l) => (l.bedrooms == null ? 1 : 0) },
  { name: 'bathrooms_dev', value: (l) => (l.bathrooms == null ? 0 : clamp(l.bathrooms, 0, 4) - 1) },
  { name: 'bathrooms_missing', value: (l) => (l.bathrooms == null ? 1 : 0) },
  { name: 'floor_scaled', value: (l) => (l.floor == null ? 0 : clamp(l.floor, -1, 8) / 4) },
  { name: 'floor_ground', value: (l) => (l.floor === 0 ? 1 : 0) },
  { name: 'floor_missing', value: (l) => (l.floor == null ? 1 : 0) },
  { name: 'total_floors_scaled', value: (l) => (l.totalFloors == null ? 0 : clamp(l.totalFloors, 1, 20) / 10) },
  { name: 'total_floors_missing', value: (l) => (l.totalFloors == null ? 1 : 0) },
  { name: 'year_scaled', value: (l) => (l.buildingYear == null ? 0 : (clamp(l.buildingYear, 1870, 2026) - 1970) / 50) },
  { name: 'year_missing', value: (l) => (l.buildingYear == null ? 1 : 0) },
  {
    name: 'type_top',
    value: (l) => (['maisonette', 'penthouse', 'attic_apartment'].includes(l.propertyType) ? 1 : 0),
  },
  { name: 'price_cold_est', value: (l) => (l.priceType === 'cold_est' ? 1 : 0) },
];

const STRUCTURED_FEATURES = [
  'balcony',
  'furnished',
  'garden',
  'terrace',
  'elevator',
  'fitted_kitchen',
  'renovated',
  'barrier_free',
  'old_building',
  'new_building',
  'balcony_absent',
  'garden_absent',
  'elevator_absent',
  'fitted_kitchen_absent',
  'furnished_full',
  'furnished_partial',
  'furnished_none',
  'lease_fixed',
  'lease_sublet',
];

/**
 * Boolean feature flags derived exclusively from the validated LLM fields.
 * @param {object} attrs canonical structured attributes
 * @returns {Record<string, boolean>}
 */
export function structuredFeatureFlags(attrs = {}) {
  const amenities = new Set(Array.isArray(attrs.amenities) ? attrs.amenities : []);
  const absent = new Set(Array.isArray(attrs.amenitiesAbsent) ? attrs.amenitiesAbsent : []);
  const renovated = ['first_occupancy', 'like_new', 'renovated', 'refurbished'].includes(attrs.condition);
  return {
    balcony: amenities.has('balcony'),
    furnished: attrs.furnished === true || amenities.has('furnished') || amenities.has('partially_furnished'),
    garden: amenities.has('garden') || amenities.has('garden_use'),
    terrace: amenities.has('terrace'),
    elevator: amenities.has('elevator'),
    fitted_kitchen: amenities.has('fitted_kitchen'),
    renovated,
    barrier_free: amenities.has('barrier_free') || amenities.has('wheelchair_accessible'),
    old_building: amenities.has('old_building'),
    new_building: amenities.has('new_building'),
    balcony_absent: absent.has('balcony'),
    garden_absent: absent.has('garden') || absent.has('garden_use'),
    elevator_absent: absent.has('elevator'),
    fitted_kitchen_absent: absent.has('fitted_kitchen'),
    furnished_full: attrs.furnishingStatus === 'full',
    furnished_partial: attrs.furnishingStatus === 'partial',
    furnished_none: attrs.furnishingStatus === 'none',
    lease_fixed: attrs.leaseType === 'fixed',
    lease_sublet: attrs.leaseType === 'sublet',
  };
}

/**
 * Names of all design-vector terms, in vector order.
 * @returns {string[]}
 */
export function hedonicTermNames() {
  return [
    ...HEDONIC_TERMS.map((term) => term.name),
    ...STRUCTURED_FEATURES,
    ...Array.from({ length: MAX_MONTH_OFFSETS }, (_, index) => `month_${index + 1}`),
  ];
}

/**
 * Build the design vector for one listing.
 * @param {object} listing needs: size, rooms, floor, buildingYear,
 *   propertyType, priceType, features (from structuredFeatureFlags), monthOffset.
 * @returns {number[]}
 */
export function hedonicDesignVector(listing) {
  const dummies = new Array(MAX_MONTH_OFFSETS).fill(0);
  const offset = listing.monthOffset ?? 0;
  if (offset >= 1) dummies[Math.min(offset, MAX_MONTH_OFFSETS) - 1] = 1;
  return [
    ...HEDONIC_TERMS.map((term) => term.value(listing)),
    ...STRUCTURED_FEATURES.map((feature) => (listing.features?.[feature] ? 1 : 0)),
    ...dummies,
  ];
}

/*
 * GBM feature space: raw values with NaN for missing — LightGBM routes
 * missing values through learned default directions, so no *_missing dummies
 * are needed. Coordinates enter at full granularity (raw degrees); trees
 * split on them into data-driven micro-districts. geo_accuracy is ordinal
 * (house > street > postcode > district); trees only use its ordering.
 */
const GEO_ACCURACY_ORDINAL = { house: 3, street: 2, postcode: 1 };

const GBM_FEATURES = [
  { name: 'size', value: (l) => numberOrNaN(l.size) },
  { name: 'rooms', value: (l) => numberOrNaN(l.rooms) },
  { name: 'bedrooms', value: (l) => numberOrNaN(l.bedrooms) },
  { name: 'bathrooms', value: (l) => numberOrNaN(l.bathrooms) },
  { name: 'floor', value: (l) => numberOrNaN(l.floor) },
  { name: 'total_floors', value: (l) => numberOrNaN(l.totalFloors) },
  { name: 'building_year', value: (l) => numberOrNaN(l.buildingYear) },
  {
    name: 'type_top',
    value: (l) => (['maisonette', 'penthouse', 'attic_apartment'].includes(l.propertyType) ? 1 : 0),
  },
  { name: 'price_cold_est', value: (l) => (l.priceType === 'cold_est' ? 1 : 0) },
  { name: 'latitude', value: (l) => numberOrNaN(l.latitude) },
  { name: 'longitude', value: (l) => numberOrNaN(l.longitude) },
  {
    name: 'geo_accuracy',
    value: (l) =>
      Number.isFinite(numberOrNaN(l.latitude)) ? (GEO_ACCURACY_ORDINAL[l.geocodeQuality] ?? 0) : Number.NaN,
  },
  { name: 'age_days', value: (l) => (Number.isFinite(l.ageDays) ? l.ageDays : 0) },
];

function numberOrNaN(value) {
  const parsed = Number(value);
  return value == null || !Number.isFinite(parsed) || parsed === -1 ? Number.NaN : parsed;
}

/**
 * Names of the GBM feature columns, in vector order.
 * @returns {string[]}
 */
export function gbmFeatureNames() {
  return [...GBM_FEATURES.map((feature) => feature.name), ...STRUCTURED_FEATURES];
}

/**
 * Build the GBM numeric feature vector for one listing. Missing values are
 * NaN (serialized as null in the trainer handoff).
 *
 * @param {object} listing needs: size, rooms, floor, buildingYear,
 *   propertyType, priceType, latitude, longitude, geocodeQuality, ageDays,
 *   features (from structuredFeatureFlags).
 * @returns {number[]}
 */
export function gbmFeatureVector(listing) {
  return [
    ...GBM_FEATURES.map((feature) => feature.value(listing)),
    ...STRUCTURED_FEATURES.map((feature) => (listing.features?.[feature] ? 1 : 0)),
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
