/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { firstBlacklistMatch } from '../../utils.js';
import { normalizeAttributes } from '../listings/standardizedFacts.js';
import {
  AMENITIES,
  CONDITIONS,
  FURNISHING_STATUS,
  OFFER_KINDS,
  UNIT_KINDS,
  RENTAL_ARRANGEMENTS,
  LEASE_DURATIONS,
  OFFERED_BY,
} from './listingSchema.js';

export const FILTER_VERSION = 2;

export class CardFacts {
  constructor(discovery) {
    this.cardTitle = text(discovery?.title);
    this.cardDescription = text(discovery?.description);
    this.cardAddress = text(discovery?.address);
    this.cardPrice = positive(discovery?.price);
    this.cardPriceType = discovery?.priceType ?? null;
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
    this.canonicalAttributes = normalizeAttributes(listing?.attributes);
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
  const terms = (job?.blacklist || []).filter(
    (term) => !intentsImpliedByTerms([term]).some((intent) => (job?.intentFilter || []).includes(intent)),
  );
  for (const [field, value] of [
    ['title', facts.cardTitle],
    ['description', facts.cardDescription],
    ['address', facts.cardAddress],
  ]) {
    const term = value && firstBlacklistMatch(String(value), terms);
    if (term) {
      reasons.push({ code: 'blacklist', stage: 'discovery', term, field });
      break;
    }
  }
  const basis = job?.specFilter?.priceBasis ?? 'advertised';
  const price = basis === 'advertised' || basis === facts.cardPriceType ? facts.cardPrice : null;
  reasons.push(
    ...numericReasons({ price, size: facts.cardSize, rooms: facts.cardRooms }, job?.specFilter, 'discovery'),
  );
  return reasons;
}

export function canonicalFilterReasons(facts, job) {
  brand(facts, CanonicalFacts, 'canonicalFilterReasons');
  const problems = specFilterProblems(job?.specFilter);
  if (problems.length) throw new TypeError(problems.join('; '));
  const attributes = facts.canonicalAttributes;
  const reasons = [];

  const excluded = new Set(job?.intentFilter || []);
  for (const rule of INTENT_RULES) {
    if (excluded.has(rule.intent) && attributes && rule.matches(attributes)) {
      reasons.push({ code: 'intent', stage: 'extraction', intent: rule.intent });
    }
  }

  const spec = job?.specFilter ?? {};
  const price =
    spec.priceBasis === 'cold'
      ? positive(attributes.coldRentEur)
      : spec.priceBasis === 'warm'
        ? positive(attributes.warmRentEur)
        : facts.canonicalPrice;
  reasons.push(
    ...numericReasons(
      { price, size: facts.canonicalSize, rooms: facts.canonicalRooms, floor: attributes.floor },
      spec,
      'extraction',
    ),
  );
  for (const [key, field] of Object.entries(CATEGORY_FIELDS)) {
    if (!spec[key]?.length) continue;
    const actual = attributes[field];
    if (isUnknown(actual)) reasons.push({ code: 'insufficient_evidence', stage: 'extraction', field });
    else if (!spec[key].includes(actual))
      reasons.push({ code: 'spec', stage: 'extraction', field, actual, required: spec[key] });
  }
  for (const name of spec.requiredAmenities ?? []) {
    if (attributes.amenities?.includes(name)) continue;
    reasons.push({
      code: attributes.amenitiesAbsent?.includes(name) ? 'spec' : 'insufficient_evidence',
      stage: 'extraction',
      field: `amenities.${name}`,
      required: true,
    });
  }
  const intentEvidence = {
    swap: 'offer_kind',
    wg_room: 'unit_kind',
    sublet: 'rental_arrangement',
    furnished: 'furnishing_status',
    fixed_term: 'lease_duration',
    non_private: 'offered_by',
    relisting_platform: 'offered_by',
  };
  const requiredFields = new Set([
    ...[...excluded].map((intent) => intentEvidence[intent]).filter(Boolean),
    ...Object.entries(CATEGORY_FIELDS)
      .filter(([key]) => spec[key]?.length)
      .map(([, field]) => EVIDENCE_FIELD[field] ?? field),
    ...Object.entries(NUMBER_FIELDS)
      .filter(([key]) => spec[key] != null)
      .flatMap(([key, rule]) =>
        key === 'maxPrice'
          ? spec.priceBasis === 'warm'
            ? ['rent.warm']
            : spec.priceBasis === 'cold'
              ? ['rent.cold']
              : ['rent.cold', 'rent.warm']
          : [rule.evidence],
      ),
    ...(spec.requiredAmenities ?? []).map((name) => `amenities.${name}`),
  ]);
  for (const evidence of attributes.evidence ?? []) {
    if (evidence.status === 'contradictory' && requiredFields.has(evidence.field))
      reasons.push({
        code: 'insufficient_evidence',
        stage: 'extraction',
        field: evidence.field,
        detail: 'contradictory',
      });
  }

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
// reproduce that reading. Discovery also defers these terms to the explicit intent rules.
const INTENT_RULES = [
  {
    intent: 'swap',
    impliedBy: /tausch|swap/u,
    matches: (a) => a.offerKind === 'swap',
  },
  {
    intent: 'wg_room',
    impliedBy: /^wg$|wohngemeinschaft/u,
    matches: (a) => ['private_room', 'shared_room'].includes(a.unitKind),
  },
  {
    intent: 'sublet',
    impliedBy: /untermiete|zwischenmiete|sublet/u,
    matches: (a) => a.rentalArrangement === 'sublet',
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
    matches: (a) => a.leaseDuration === 'fixed',
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

const CATEGORY_FIELDS = {
  offerKinds: 'offerKind',
  unitKinds: 'unitKind',
  rentalArrangements: 'rentalArrangement',
  leaseDurations: 'leaseDuration',
  furnishingStatuses: 'furnishingStatus',
  offeredBy: 'offeredBy',
  conditions: 'condition',
};
const CATEGORY_VALUES = {
  offerKinds: OFFER_KINDS,
  unitKinds: UNIT_KINDS,
  rentalArrangements: RENTAL_ARRANGEMENTS,
  leaseDurations: LEASE_DURATIONS,
  furnishingStatuses: FURNISHING_STATUS,
  offeredBy: OFFERED_BY,
  conditions: CONDITIONS,
  requiredAmenities: AMENITIES,
};
const EVIDENCE_FIELD = {
  offerKind: 'offer_kind',
  unitKind: 'unit_kind',
  rentalArrangement: 'rental_arrangement',
  leaseDuration: 'lease_duration',
  furnishingStatus: 'furnishing_status',
  offeredBy: 'offered_by',
};
const NUMBER_FIELDS = {
  minRooms: { field: 'rooms', evidence: 'rooms', min: 0.5 },
  minSize: { field: 'size', evidence: 'size_sqm', min: 1 },
  minFloor: { field: 'floor', evidence: 'floor', min: -2 },
  maxPrice: { field: 'price', evidence: 'rent.cold', min: 1, maximum: true },
};

export function specFilterProblems(spec) {
  if (spec == null) return [];
  if (typeof spec !== 'object' || Array.isArray(spec)) return ['specFilter must be an object or null'];
  const problems = [];
  for (const [key, value] of Object.entries(spec)) {
    if (NUMBER_FIELDS[key]) {
      if (!Number.isFinite(value) || value < NUMBER_FIELDS[key].min)
        problems.push(`specFilter.${key} must be a number >= ${NUMBER_FIELDS[key].min}`);
    } else if (key === 'priceBasis') {
      if (!['cold', 'warm', 'advertised'].includes(value))
        problems.push('specFilter.priceBasis must be cold, warm or advertised');
    } else if (CATEGORY_VALUES[key]) {
      if (
        !Array.isArray(value) ||
        !value.length ||
        value.some((v) => !CATEGORY_VALUES[key].includes(v)) ||
        new Set(value).size !== value.length
      )
        problems.push(`specFilter.${key} must be a non-empty set from ${CATEGORY_VALUES[key].join(', ')}`);
    } else problems.push(`Unknown specFilter key '${key}'`);
  }
  return problems;
}

function numericReasons(values, spec, stage) {
  const reasons = [];
  for (const [key, rule] of Object.entries(NUMBER_FIELDS)) {
    const required = spec?.[key];
    if (required == null) continue;
    const actual = values[rule.field];
    if (actual == null) {
      if (stage === 'extraction') reasons.push({ code: 'insufficient_evidence', stage, field: rule.field, required });
    } else if (rule.maximum ? actual > required : actual < required)
      reasons.push({ code: 'spec', stage, field: rule.field, actual, required });
  }
  return reasons;
}

function isUnknown(value) {
  return value == null || value === 'unknown';
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
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
