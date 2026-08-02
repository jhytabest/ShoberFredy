/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { firstBlacklistMatch } from '../../utils.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { addressKey } from '../geocoding/address.js';
import { getCachedAccuracy } from '../geocoding/geocodeCache.js';
import { geocodeAddress } from '../geocoding/geoCodingService.js';
import { env } from '../../shared/env.js';
import { positiveNumber } from '../../shared/values.js';

/**
 * What each stage knows, and what it is allowed to decide with it.
 *
 * Facts and rules live together because they are the same subject: a stage is
 * defined by the evidence it has. Three shapes with no shared field name, so a
 * rule cannot read evidence from another stage even by accident — the properties
 * are simply not there, and every rule brands its input so the mistake throws
 * rather than silently filtering on nothing.
 *
 * The stages differ on purpose, by what they cost:
 *
 *   card        blacklist and specification, over what the card states. Free.
 *   detail      geography only. The page must be fetched for extraction anyway.
 *   extraction  structured fields, and one geographic check re-derived from the
 *               canonical address.
 *
 * There is no text matching after extraction. The model answers "swap, sublet,
 * WG room, furnished, fixed-term, relisting platform" as validated enum fields;
 * grepping the page for the same thing asks twice and believes the worse answer.
 *
 * CanonicalFacts deliberately has no coordinates from an earlier stage. The
 * pre-extraction geocode ran on a scraped address, and inheriting it let a
 * district centroid decide a listing the model had since given a house number.
 */

/** Geocode precisions confident enough to reject before extraction. */
const REJECTABLE_PRECISION = new Set(
  String(env('FREDY_PRELLM_AREA_MIN_PRECISION'))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

/* --------------------------------- facts --------------------------------- */

/** What a search-results card states. Cheapest evidence, least trusted. */
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

/** Where the property is, mined from the detail page. Nothing else. */
export class GeoFacts {
  constructor(deterministic, discovery) {
    // The mined address counts only when it came from structured data rather
    // than prose; otherwise the card's own address is the better weak answer.
    const mined = deterministic?.address;
    const trusted = mined?.value != null && (mined.confidence === 'high' || mined.confidence === 'medium');
    this.geoAddress = text(trusted ? mined.value : discovery?.address);
    this.geoLat = positiveOrNull(deterministic?.coords?.lat);
    this.geoLng = positiveOrNull(deterministic?.coords?.lng);
    this.geoPrecision = deterministic?.coords?.precision ?? null;
    Object.freeze(this);
  }
}

/** The extraction. The only facts that are ever canonical. */
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

/* --------------------------------- rules --------------------------------- */

/**
 * The card stage. Free, so it runs on every sighting.
 *
 * The matcher already refuses the traps that make substring matching wrong in
 * German: `möbliert` does not fire on `unmöbliert`, `Tausch` does not fire on
 * `Austausch`, `WG` matches only as a whole token and not inside `Wegweiser`.
 *
 * @param {CardFacts} facts
 * @param {object} job
 * @returns {{code: string, stage: string, term?: string, field?: string}[]}
 */
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

/**
 * The detail stage. One question: is it even in the right place?
 *
 * Rejects only when the geocode is precise enough to name a building and the
 * point is outside every interested job's polygons. A district centroid is the
 * same point for a whole neighbourhood and carries no evidence about which
 * building this is, so anything coarse falls through to the model.
 *
 * The union over jobs is what makes doing the work once safe: an advert any job
 * wants must reach extraction, and per-job geography is settled again afterwards.
 *
 * @param {GeoFacts} facts
 * @param {object[]} jobs every job interested in this advert
 * @returns {Promise<{code: string, stage: string}|null>}
 */
export async function geoRejectReason(facts, jobs) {
  brand(facts, GeoFacts, 'geoRejectReason');
  const sets = (jobs || []).map(polygonsOf);
  // A job with no polygon accepts everywhere, which makes the union everywhere.
  if (!sets.length || sets.some((polygons) => !polygons.length)) return null;

  const point = await confidentPoint(facts);
  if (!point) return null;
  const inside = sets.some((polygons) => !outside(polygons, point.lat, point.lng));
  return inside ? null : { code: 'area', stage: 'detail' };
}

/**
 * The extraction stage. Structured fields, and geography from the canonical
 * address.
 *
 * @param {CanonicalFacts} facts
 * @param {object} job
 * @returns {{code: string, stage: string}[]}
 */
export function canonicalFilterReasons(facts, job) {
  brand(facts, CanonicalFacts, 'canonicalFilterReasons');
  const attributes = facts.canonicalAttributes;
  const reasons = [];

  for (const rule of INTENT_RULES) {
    const configured = (job?.blacklist || []).some((term) => rule.term.test(String(term).toLocaleLowerCase('de-DE')));
    // Only a positive identification rejects. The model saying it could not tell
    // is not evidence that the answer is yes.
    if (configured && attributes && rule.matches(attributes)) {
      reasons.push({ code: 'intent', stage: 'extraction', intent: rule.intent });
    }
  }

  reasons.push(
    ...specReasons(facts.canonicalPrice, facts.canonicalSize, facts.canonicalRooms, job?.specFilter, 'extraction'),
  );

  // A listing with no rent cannot be judged: it escapes maxPrice, it cannot be
  // scored, and it is not actionable. The model has read the whole page by now,
  // so a still-missing price means the advert names none.
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

/**
 * The blacklist terms a structured field can answer for.
 *
 * The rules are derived from the blacklist already configured, so nothing needs
 * reconfiguring: "Tauschwohnung" and "Wohnungsswap" both express "no swaps" and
 * both map onto the same predicate. A term that matches no rule is a card-stage
 * term only — after extraction there is nothing to grep.
 */
const INTENT_RULES = [
  {
    intent: 'swap',
    term: /tausch|swap/u,
    matches: (a) => a.listingType === 'swap' || a.leaseType === 'swap' || a.swap === true,
  },
  { intent: 'wg_room', term: /^wg$|wohngemeinschaft/u, matches: (a) => a.listingType === 'wg_room' },
  {
    intent: 'sublet',
    term: /untermiete|zwischenmiete|sublet/u,
    matches: (a) => a.listingType === 'sublet' || a.leaseType === 'sublet',
  },
  {
    intent: 'furnished',
    term: /m(ö|o)b|furnish/u,
    // Only `full`. `partial` is teilmöbliert, which in Berlin usually means an
    // Einbauküche and some built-ins rather than a furnished home, and a flat
    // that comes with a fitted kitchen is not the thing "no möbliert" is asking
    // to avoid.
    //
    // This rule decides more listings than every other rule in this file
    // combined — 374 of the last 402 refusals — and 54 of those were `partial`
    // on ordinary open-ended rentals. The blacklist could not express the
    // difference either: `möbliert` and `teilmöbeliert` are separate configured
    // terms but both reduce to this one predicate, so there was no way to refuse
    // one and keep the other.
    //
    // furnishingStatus is the only place furnishing is recorded; the derived
    // `furnished` boolean is a view of it, so testing both proved nothing.
    matches: (a) => a.furnishingStatus === 'full',
  },
  {
    intent: 'relisting_platform',
    // A portal name in a keyword list is a proxy for "this is not the landlord",
    // which `offered_by` states directly.
    term: /housinganywhere|spotahome|wunderflats|homelike|nestpick/u,
    matches: (a) => a.offeredBy === 'relisting_platform',
  },
  {
    intent: 'fixed_term',
    term: /befristet|auf zeit|temporary|short.?term|kurzzeit/u,
    matches: (a) => a.leaseType === 'fixed',
  },
];

/** The first reason is the one shown; they are already in evidence order. */
export function primaryFilterReason(reasons) {
  return reasons?.length ? reasons[0].code : null;
}

/** The stage that produced the reason shown, for the verdict row. */
export function primaryFilterStage(reasons) {
  return reasons?.length ? reasons[0].stage : null;
}

/* -------------------------------- helpers -------------------------------- */

/**
 * A point precise enough to reject on, or null. Structured coordinates the
 * provider published for an exact address are taken as given; otherwise the
 * stated address is geocoded and used only when it resolved to a building or a
 * street.
 */
async function confidentPoint(facts) {
  if (facts.geoPrecision === 'exact' && facts.geoLat != null && facts.geoLng != null) {
    return { lat: facts.geoLat, lng: facts.geoLng };
  }
  if (!facts.geoAddress) return null;
  const point = await geocodeAddress(facts.geoAddress);
  if (!point || !Number.isFinite(point.lat) || point.lat === -1) return null;
  const accuracy = getCachedAccuracy(SqliteConnection.getConnection(), addressKey, facts.geoAddress);
  return REJECTABLE_PRECISION.has(accuracy) ? { lat: point.lat, lng: point.lng } : null;
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
