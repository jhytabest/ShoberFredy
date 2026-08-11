/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { firstBlacklistMatch } from '../../utils.js';
import { positiveNumber } from '../../shared/values.js';

export class CardFacts {
  constructor(discovery) {
    this.cardTitle = text(discovery?.title);
    this.cardDescription = text(discovery?.description);
    this.cardAddress = text(discovery?.address);
    this.cardPrice = positive(discovery?.price);
    this.cardSize = positive(discovery?.size);
    this.cardRooms = positive(discovery?.rooms);
    Object.freeze(this);
  }
}

export class CanonicalFacts {
  constructor(listing) {
    this.canonicalTitle = text(listing?.title);
    this.canonicalAddress = text(listing?.address);
    this.canonicalPrice = positive(listing?.price);
    this.canonicalSize = positive(listing?.size);
    this.canonicalRooms = positive(listing?.rooms);
    this.canonicalLat = positiveOrNull(listing?.latitude);
    this.canonicalLng = positiveOrNull(listing?.longitude);
    this.canonicalAttributes = listing?.attributes ?? null;
    Object.freeze(this);
  }
}

function brand(facts, shape, rule) {
  if (!(facts instanceof shape)) {
    throw new TypeError(`${rule} expects ${shape.name}; stage facts are not interchangeable.`);
  }
}

export function cardFilterReasons(facts, job) {
  brand(facts, CardFacts, 'cardFilterReasons');
  const reasons = [];
  for (const [field, value] of [
    ['title', facts.cardTitle],
    ['description', facts.cardDescription],
    ['address', facts.cardAddress],
  ]) {
    const term = value && firstBlacklistMatch(String(value), job?.blacklist || []);
    if (term) {
      reasons.push({ code: 'blacklist', stage: 'discovery', term, field });
      break;
    }
  }
  reasons.push(...specReasons(facts.cardPrice, facts.cardSize, facts.cardRooms, job?.specFilter, 'discovery'));
  return reasons;
}

export function canonicalFilterReasons(facts, job) {
  brand(facts, CanonicalFacts, 'canonicalFilterReasons');
  const attributes = facts.canonicalAttributes;
  const reasons = [];

  const excluded = new Set(job?.intentFilter || []);
  for (const rule of INTENT_RULES) {
    if (excluded.has(rule.intent) && attributes && rule.matches(attributes)) {
      reasons.push({ code: 'intent', stage: 'extraction', intent: rule.intent });
    }
  }

  reasons.push(
    ...specReasons(facts.canonicalPrice, facts.canonicalSize, facts.canonicalRooms, job?.specFilter, 'extraction'),
  );

  if (facts.canonicalPrice == null) reasons.push({ code: 'no_price', stage: 'extraction' });

  const polygons = polygonsOf(job);
  if (polygons.length) {
    if (facts.canonicalLat == null || facts.canonicalLng == null) {
      reasons.push({ code: 'no_coordinates', stage: 'extraction' });
    } else if (outside(polygons, facts.canonicalLat, facts.canonicalLng)) {
      reasons.push({ code: 'area', stage: 'extraction' });
    }
  }
  return reasons;
}

// What a job can refuse once the model has read the advert. Each rule reads
// validated enum fields, so the vocabulary is closed and a job names the codes
// it wants gone rather than words the page might happen to use.
//
// `impliedBy` exists for one reason: these used to be switched on by matching
// blacklist terms, and the migration that moved them onto the job has to
// reproduce that reading exactly once. It is not consulted at runtime.
const INTENT_RULES = [
  {
    intent: 'swap',
    impliedBy: /tausch|swap/u,
    matches: (a) => a.listingType === 'swap' || a.leaseType === 'swap' || a.swap === true,
  },
  { intent: 'wg_room', impliedBy: /^wg$|wohngemeinschaft/u, matches: (a) => a.listingType === 'wg_room' },
  {
    intent: 'sublet',
    impliedBy: /untermiete|zwischenmiete|sublet/u,
    matches: (a) => a.listingType === 'sublet' || a.leaseType === 'sublet',
  },
  {
    intent: 'furnished',
    impliedBy: /m(ö|o)b|furnish/u,
    matches: (a) => a.furnishingStatus === 'full',
  },
  {
    intent: 'relisting_platform',
    impliedBy: /housinganywhere|spotahome|wunderflats|homelike|nestpick/u,
    matches: (a) => a.offeredBy === 'relisting_platform',
  },
  {
    intent: 'non_private',
    impliedBy: /makler|agentur|hausverwaltung|gewerblich|property.?management/u,
    matches: (a) => a.offeredBy !== 'private',
  },
  {
    intent: 'fixed_term',
    impliedBy: /befristet|auf zeit|temporary|short.?term|kurzzeit/u,
    matches: (a) => a.leaseType === 'fixed',
  },
];

export const INTENT_CODES = INTENT_RULES.map((rule) => rule.intent);

export function intentsImpliedByTerms(terms) {
  const lowered = (Array.isArray(terms) ? terms : []).map((term) => String(term).toLocaleLowerCase('de-DE'));
  return INTENT_RULES.filter((rule) => lowered.some((term) => rule.impliedBy.test(term))).map((rule) => rule.intent);
}

export function primaryFilterReason(reasons) {
  return reasons?.length ? reasons[0].code : null;
}

export function primaryFilterStage(reasons) {
  return reasons?.length ? reasons[0].stage : null;
}

export function primaryFilterTerm(reasons) {
  const reason = reasons?.length ? reasons[0] : null;
  if (!reason) return null;
  return reason.term ?? reason.intent ?? reason.field ?? null;
}

function specReasons(price, size, rooms, specFilter, stage) {
  const reasons = [];
  for (const [field, actual, required, fails] of [
    ['rooms', rooms, positiveNumber(specFilter?.minRooms), (a, r) => a < r],
    ['size', size, positiveNumber(specFilter?.minSize), (a, r) => a < r],
    ['price', price, positiveNumber(specFilter?.maxPrice), (a, r) => a > r],
  ]) {
    if (required != null && actual != null && fails(actual, required)) {
      reasons.push({ code: 'spec', stage, field, actual, required });
    }
  }
  return reasons;
}

function polygonsOf(job) {
  return job?.spatialFilter?.features?.filter((feature) => feature.geometry?.type === 'Polygon') ?? [];
}

function outside(polygons, lat, lng) {
  return !polygons.some((polygon) => booleanPointInPolygon([lng, lat], polygon));
}

function text(value) {
  return String(value ?? '').trim() || null;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
