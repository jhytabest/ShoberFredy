/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { normalizeAttributes } from '../listings/standardizedFacts.js';

export const FILTER_VERSION = 3;
export const DEFAULT_FILTERS = Object.freeze({
  minSize: 60, maxColdRent: 2500, excludeSwap: true, excludeRooms: true,
  excludeSublet: true, excludeFixedTerm: true, excludeFurnished: true, excludeNonAltbau: true,
  spatialFilter: null,
});

// This function knows only standardized features and policy, never advert text or jobs.
export function filterListing(listing, filters = DEFAULT_FILTERS) {
  const a = normalizeAttributes(listing.attributes);
  const reasons = [];
  const reject = (condition, field, actual) => {
    if (condition) reasons.push({ field, actual });
  };
  reject(knownNumber(listing.size) && filters.minSize != null && listing.size < filters.minSize, 'size', listing.size);
  reject(knownNumber(a.coldRentEur) && filters.maxColdRent != null && a.coldRentEur > filters.maxColdRent, 'coldRentEur', a.coldRentEur);
  reject(filters.excludeSwap && a.offerKind === 'swap', 'offerKind', a.offerKind);
  reject(filters.excludeRooms && ['private_room', 'shared_room'].includes(a.unitKind), 'unitKind', a.unitKind);
  reject(filters.excludeSublet && a.rentalArrangement === 'sublet', 'rentalArrangement', a.rentalArrangement);
  reject(filters.excludeFixedTerm && a.leaseDuration === 'fixed', 'leaseDuration', a.leaseDuration);
  reject(filters.excludeFurnished && a.furnishingStatus === 'full', 'furnishingStatus', a.furnishingStatus);
  reject(filters.excludeNonAltbau && a.amenitiesAbsent?.includes('old_building'), 'old_building', false);
  const polygons = filters.spatialFilter?.features ?? [];
  if (polygons.length && listing.geocodeAccuracy === 'house' &&
      Number.isFinite(listing.latitude) && Number.isFinite(listing.longitude)) {
    reject(!polygons.some((polygon) => booleanPointInPolygon([listing.longitude, listing.latitude], polygon)), 'area', 'outside');
  }
  return reasons;
}

function knownNumber(value) { return typeof value === 'number' && Number.isFinite(value); }

export function filterProblems(filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return ['filters must be an object'];
  const problems = [];
  for (const [key, value] of Object.entries(filters)) {
    if (!(key in DEFAULT_FILTERS)) problems.push(`Unknown filter '${key}'`);
    else if (key === 'minSize' || key === 'maxColdRent') {
      if (value !== null && (!knownNumber(value) || value <= 0)) problems.push(`${key} must be positive or null`);
    } else if (key === 'spatialFilter') problems.push(...spatialProblems(value));
    else if (typeof value !== 'boolean') problems.push(`${key} must be boolean`);
  }
  return problems;
}

export function spatialProblems(value) {
  if (value == null) return [];
  const point = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  const ring = (r) => Array.isArray(r) && r.length >= 4 && r.every(point) && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1];
  if (value.type !== 'FeatureCollection' || !Array.isArray(value.features) || !value.features.length ||
      !value.features.every((f) => f?.type === 'Feature' && f.geometry?.type === 'Polygon' && Array.isArray(f.geometry.coordinates) && f.geometry.coordinates.length && f.geometry.coordinates.every(ring)))
    return ['spatialFilter must be null or a FeatureCollection of valid closed Polygons'];
  return [];
}

// Frozen migration 100 imports this historical translator; runtime filtering never uses it.
export function intentsImpliedByTerms(terms) {
  const rules = { swap: /tausch|swap/u, wg_room: /^wg$|wohngemeinschaft/u,
    sublet: /untermiete|zwischenmiete|sublet/u, furnished: /m(ö|o)b|furnish/u,
    relisting_platform: /housinganywhere|spotahome|wunderflats|homelike|nestpick/u,
    non_private: /makler|agentur|hausverwaltung|gewerblich|property.?management/u,
    fixed_term: /befristet|auf zeit|temporary|short.?term|kurzzeit/u };
  const values = (Array.isArray(terms) ? terms : []).map((v) => String(v).toLocaleLowerCase('de-DE'));
  return Object.entries(rules).filter(([, pattern]) => values.some((v) => pattern.test(v))).map(([intent]) => intent);
}
