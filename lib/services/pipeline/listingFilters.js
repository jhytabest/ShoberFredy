/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { firstBlacklistMatch } from '../../utils.js';
import { positiveNumber } from '../../shared/values.js';

/**
 * What each stage knows, and what it is allowed to decide with it.
 *
 * Facts and rules live together because they are the same subject: a stage is
 * defined by the evidence it has. Two shapes with no shared field name, so a
 * rule cannot read evidence from the other stage even by accident — the
 * properties are simply not there, and every rule brands its input so the
 * mistake throws rather than silently filtering on nothing.
 *
 * Two stages, and they differ by what they cost:
 *
 *   card        blacklist and specification, over what the card states. Free.
 *   extraction  structured fields, and geography from the canonical address.
 *
 * There was a third. The detail stage geocoded a scraped address and refused
 * adverts outside every interested job's polygons, which meant guessing at the
 * location from the worst evidence available in order to save a page that had
 * already been fetched. Geography is now settled exactly once, from the address
 * the model read, which is the only address worth trusting: the earlier one was
 * often a district centroid, one point standing for a whole neighbourhood.
 *
 * There is no text matching after extraction. The model answers "swap, sublet,
 * WG room, furnished, fixed-term, relisting platform" as validated enum fields;
 * grepping the page for the same thing asks twice and believes the worse answer.
 */

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

/*
 * What inside the reason fired, so a rejection count can be read per configured
 * term instead of as one undifferentiated 'blacklist' total. The discriminator
 * is named per code because each filter narrows on a different thing: a
 * blacklist on the configured term, an intent rule on the intent it proved, a
 * specification on the field that failed. Codes that narrow on nothing have
 * none, and store NULL.
 */
export function primaryFilterTerm(reasons) {
  const reason = reasons?.length ? reasons[0] : null;
  if (!reason) return null;
  return reason.term ?? reason.intent ?? reason.field ?? null;
}

/* -------------------------------- helpers -------------------------------- */

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
