/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { socialHousingFlags } from './socialHousing.js';

const BASELINE_SIZE_SQM = 70;
const BASELINE_ROOMS = 2;

const ENERGY_CLASS_ORDINAL = { 'A+': 9, A: 8, B: 7, C: 6, D: 5, E: 4, F: 3, G: 2, H: 1 };
const CONDITION_ORDINAL = {
  needs_renovation: 1,
  well_maintained: 2,
  refurbished: 3,
  renovated: 4,
  first_occupancy_after_renovation: 5,
  like_new: 6,
  first_occupancy: 7,
};

function conditionOrdinal(listing) {
  return CONDITION_ORDINAL[listing.condition] ?? 0;
}

function energyClassOrdinal(listing) {
  return ENERGY_CLASS_ORDINAL[listing.energyClass] ?? 0;
}

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
  { name: 'condition_scaled', value: (l) => conditionOrdinal(l) / 7 },
  { name: 'condition_missing', value: (l) => (conditionOrdinal(l) === 0 ? 1 : 0) },
  { name: 'energy_class_scaled', value: (l) => energyClassOrdinal(l) / 9 },
  { name: 'energy_class_missing', value: (l) => (energyClassOrdinal(l) === 0 ? 1 : 0) },
];

const STRUCTURED_FEATURES = [
  'balcony',
  'garden',
  'terrace',
  'elevator',
  'fitted_kitchen',
  'cellar',
  'bathtub',
  'guest_toilet',
  'dishwasher',
  'washing_machine',
  'parquet',
  'underfloor_heating',
  'renovated',
  'barrier_free',
  'old_building',
  'new_building',
  'balcony_absent',
  'garden_absent',
  'elevator_absent',
  'fitted_kitchen_absent',
  'furnished_partial',
  'furnished_none',
  'parking',
  'underground_parking',
  'wbs_required',
  'social_landlord',
];

export function structuredFeatureFlags(attrs = {}, freeText = '') {
  const amenities = new Set(Array.isArray(attrs.amenities) ? attrs.amenities : []);
  const absent = new Set(Array.isArray(attrs.amenitiesAbsent) ? attrs.amenitiesAbsent : []);
  const regulated = socialHousingFlags([attrs.comments, attrs.summary, freeText].filter(Boolean).join(' . '));
  const renovated = [
    'first_occupancy',
    'first_occupancy_after_renovation',
    'like_new',
    'renovated',
    'refurbished',
  ].includes(attrs.condition);
  return {
    balcony: amenities.has('balcony'),
    garden: amenities.has('garden') || amenities.has('garden_use'),
    terrace: amenities.has('terrace'),
    elevator: amenities.has('elevator'),
    fitted_kitchen: amenities.has('fitted_kitchen'),
    cellar: amenities.has('cellar'),
    bathtub: amenities.has('bathtub'),
    guest_toilet: amenities.has('guest_toilet'),
    dishwasher: amenities.has('dishwasher'),
    washing_machine: amenities.has('washing_machine'),
    parquet: amenities.has('parquet'),
    underfloor_heating: amenities.has('underfloor_heating'),
    renovated,
    barrier_free: amenities.has('barrier_free') || amenities.has('wheelchair_accessible'),
    old_building: amenities.has('old_building'),
    new_building: amenities.has('new_building'),
    balcony_absent: absent.has('balcony'),
    garden_absent: absent.has('garden') || absent.has('garden_use'),
    elevator_absent: absent.has('elevator'),
    fitted_kitchen_absent: absent.has('fitted_kitchen'),
    furnished_partial: attrs.furnishingStatus === 'partial',
    furnished_none: attrs.furnishingStatus === 'none',
    parking: amenities.has('parking') || amenities.has('garage') || amenities.has('underground_parking'),
    underground_parking: amenities.has('underground_parking'),
    wbs_required: regulated.wbsRequired,
    social_landlord: regulated.socialLandlord,
  };
}

export function hedonicTermNames() {
  return [...HEDONIC_TERMS.map((term) => term.name), ...STRUCTURED_FEATURES];
}

export function hedonicDesignVector(listing) {
  return [
    ...HEDONIC_TERMS.map((term) => term.value(listing)),
    ...STRUCTURED_FEATURES.map((feature) => (listing.features?.[feature] ? 1 : 0)),
  ];
}

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
  { name: 'latitude', value: (l) => numberOrNaN(l.latitude) },
  { name: 'longitude', value: (l) => numberOrNaN(l.longitude) },
  {
    name: 'geo_accuracy',
    value: (l) =>
      Number.isFinite(numberOrNaN(l.latitude)) ? (GEO_ACCURACY_ORDINAL[l.geocodeQuality] ?? 0) : Number.NaN,
  },
];

function numberOrNaN(value) {
  const parsed = Number(value);
  return value == null || !Number.isFinite(parsed) || parsed === -1 ? Number.NaN : parsed;
}

export function gbmFeatureNames() {
  return [...GBM_FEATURES.map((feature) => feature.name), ...STRUCTURED_FEATURES];
}

export function gbmFeatureVector(listing) {
  return [
    ...GBM_FEATURES.map((feature) => feature.value(listing)),
    ...STRUCTURED_FEATURES.map((feature) => (listing.features?.[feature] ? 1 : 0)),
  ];
}

export function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
