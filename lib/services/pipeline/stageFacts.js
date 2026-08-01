/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * What each stage is allowed to know.
 *
 * There used to be one fact object. It merged the search card, the values mined
 * out of the detail page, and the LLM's canonical extraction into a single flat
 * shape with one set of field names, resolved by a fallback chain:
 *
 *     price: listing?.price ?? trusted(deterministic?.price) ?? discovery?.price
 *
 * so `facts.price` meant a different thing at every call site, and the only
 * thing stopping a scraped guess from being treated as a canonical fact was
 * whoever wrote the caller remembering which stage they were in. The comment
 * saying deterministic values "gate only, they never become canonical" was
 * load-bearing documentation for an invariant nothing enforced.
 *
 * Three shapes, no shared field name. A rule written against one cannot read the
 * others, because the properties are not there — a leak is now a bug that shows
 * up the first time the code runs, rather than a wrong verdict that looks fine.
 *
 * The classes are the enforcement. This repo has no type checker, so distinct
 * names alone would only give you `undefined`; every rule brands its input, so
 * handing a card to a canonical rule throws instead of silently filtering on
 * nothing.
 *
 * The most important consequence is structural: CanonicalFacts has no
 * coordinates *from an earlier stage*. Post-extraction geography is resolved
 * from the canonical address only, because the pre-LLM geocode was performed on
 * a scraped address string and inheriting it let a coarse district centroid
 * decide a listing the LLM had since given a house number.
 */

/** What a search-results card states. Cheapest evidence, and the least trusted. */
export class CardFacts {
  constructor({ cardTitle, cardDescription, cardAddress, cardPrice, cardSize, cardRooms }) {
    this.cardTitle = cardTitle ?? null;
    this.cardDescription = cardDescription ?? null;
    this.cardAddress = cardAddress ?? null;
    this.cardPrice = cardPrice ?? null;
    this.cardSize = cardSize ?? null;
    this.cardRooms = cardRooms ?? null;
    Object.freeze(this);
  }
}

/**
 * What the detail page yields about where the property is, and nothing else.
 *
 * Deliberately carries no text and no specification: the detail stage no longer
 * filters on either. Those checks rejected 215 adverts in a week — after the
 * page fetch they were meant to save had already been paid — while the geographic
 * check they sat beside rejected 855. The stage that must fetch the page anyway
 * for extraction has exactly one question worth asking before the LLM: is this
 * even in the right place?
 */
export class GeoFacts {
  constructor({ geoAddress, geoLat, geoLng, geoPrecision }) {
    this.geoAddress = geoAddress ?? null;
    this.geoLat = Number.isFinite(geoLat) ? geoLat : null;
    this.geoLng = Number.isFinite(geoLng) ? geoLng : null;
    this.geoPrecision = geoPrecision ?? null;
    Object.freeze(this);
  }
}

/** The extraction. The only facts that are ever canonical. */
export class CanonicalFacts {
  constructor({
    canonicalTitle,
    canonicalAddress,
    canonicalPrice,
    canonicalSize,
    canonicalRooms,
    canonicalLat,
    canonicalLng,
    canonicalAttributes,
  }) {
    this.canonicalTitle = canonicalTitle ?? null;
    this.canonicalAddress = canonicalAddress ?? null;
    this.canonicalPrice = canonicalPrice ?? null;
    this.canonicalSize = canonicalSize ?? null;
    this.canonicalRooms = canonicalRooms ?? null;
    this.canonicalLat = Number.isFinite(canonicalLat) ? canonicalLat : null;
    this.canonicalLng = Number.isFinite(canonicalLng) ? canonicalLng : null;
    this.canonicalAttributes = canonicalAttributes ?? null;
    Object.freeze(this);
  }
}

/**
 * @param {object} discovery discovery card as the provider returned it
 * @returns {CardFacts}
 */
export function cardFacts(discovery) {
  return new CardFacts({
    cardTitle: text(discovery?.title),
    cardDescription: text(discovery?.description),
    cardAddress: text(discovery?.address),
    cardPrice: positive(discovery?.price),
    cardSize: positive(discovery?.size),
    cardRooms: positive(discovery?.rooms),
  });
}

/**
 * @param {object|null} deterministic output of extractDeterministicDetail
 * @param {object} discovery discovery card, for the address the page omits
 * @returns {GeoFacts}
 */
export function geoFacts(deterministic, discovery) {
  // The mined address is trusted only when the miner says it read it from
  // structured data rather than guessed it out of prose; otherwise the card's
  // own address is the better of two weak answers.
  const mined = deterministic?.address;
  const address =
    mined?.value != null && (mined.confidence === 'high' || mined.confidence === 'medium')
      ? mined.value
      : (discovery?.address ?? null);
  const coords = deterministic?.coords ?? null;
  return new GeoFacts({
    geoAddress: text(address),
    geoLat: Number(coords?.lat),
    geoLng: Number(coords?.lng),
    geoPrecision: coords?.precision ?? null,
  });
}

/**
 * @param {object} listing canonical listing built from the extraction
 * @returns {CanonicalFacts}
 */
export function canonicalFacts(listing) {
  return new CanonicalFacts({
    canonicalTitle: text(listing?.title),
    canonicalAddress: text(listing?.address),
    canonicalPrice: positive(listing?.price),
    canonicalSize: positive(listing?.size),
    canonicalRooms: positive(listing?.rooms),
    canonicalLat: Number(listing?.latitude),
    canonicalLng: Number(listing?.longitude),
    canonicalAttributes: listing?.attributes ?? null,
  });
}

/**
 * Refuse facts from the wrong stage.
 *
 * @param {object} facts
 * @param {Function} shape one of the three classes
 * @param {string} rule name of the rule being applied, for the message
 * @returns {void}
 */
export function assertFacts(facts, shape, rule) {
  if (!(facts instanceof shape)) {
    throw new TypeError(`${rule} expects ${shape.name}; stage facts are not interchangeable.`);
  }
}

function text(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
