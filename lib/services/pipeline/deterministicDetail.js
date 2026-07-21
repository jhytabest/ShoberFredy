/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Tier 2 of the three information tiers (discovery card → deterministic detail
 * → LLM). This module mines a small, high-confidence set of facts (price, size,
 * rooms, address, coordinates) from the captured detail evidence so the pre-LLM
 * gate can reject listings that a blacklist / specification / area filter would
 * discard anyway, before spending a scarce LLM call.
 *
 * It is pure, side-effect free and DELIBERATELY NON-CANONICAL: nothing produced
 * here may ever replace an LLM field. Every field is returned with a confidence
 * so the caller can stay fail-open (only act on confident values, never reject
 * on a guess). ImmoScout exposes carry structured attributes and rooftop
 * coordinates and are the primary, reliable source; other providers fall back
 * to generic JSON-LD and finally to conservative full-text regex (which returns
 * null whenever it sees more than one candidate value).
 */

import { extractNumber } from '../../utils/extract-number.js';

/**
 * @typedef {{ value: number|null, source: string, confidence: 'high'|'medium'|'low' }} DetNumber
 * @typedef {{ value: string|null, source: string, confidence: 'high'|'medium'|'low' }} DetString
 * @typedef {{ lat: number, lng: number, precision: 'exact', source: string }} DetCoords
 * @typedef {{ price: DetNumber, size: DetNumber, rooms: DetNumber, address: DetString,
 *   coords: DetCoords|null, blacklistText: string }} DeterministicDetail
 */

const EMPTY_NUMBER = { value: null, source: 'none', confidence: 'low' };
const EMPTY_STRING = { value: null, source: 'none', confidence: 'low' };

/**
 * Extract deterministic facts from a prepared detail capture.
 * @param {{ provider?: string, fullText?: string, embeddedData?: Array<{kind:string,value:any}> }} capture
 * @param {object} [discovery] discovery card (used only as a weak last resort)
 * @returns {DeterministicDetail}
 */
export function extractDeterministicDetail(capture, discovery) {
  const embedded = Array.isArray(capture?.embeddedData) ? capture.embeddedData : [];
  const fullText = typeof capture?.fullText === 'string' ? capture.fullText : '';

  const structured = fromImmoscoutExpose(embedded) || fromImmoweltClassified(embedded) || fromJsonLd(embedded) || {};

  const price = structured.price ?? numberFromText(fullText, PRICE_PATTERNS, 'low');
  const size = structured.size ?? numberFromText(fullText, SIZE_PATTERNS, 'low');
  const rooms = structured.rooms ?? numberFromText(fullText, ROOMS_PATTERNS, 'low');
  const address = structured.address ?? EMPTY_STRING;
  const coords = structured.coords ?? null;
  const blacklistText = [structured.blacklistText, address.value, discovery?.address].filter(Boolean).join('\n');

  return { price, size, rooms, address, coords, blacklistText };
}

// --- ImmoScout mobile expose (structured, high confidence) --------------------

function fromImmoscoutExpose(embedded) {
  const expose = embedded.find((entry) => entry?.kind === 'immoscout-expose')?.value;
  const sections = Array.isArray(expose?.sections) ? expose.sections : null;
  if (!sections) return null;

  const section = (type) => sections.find((entry) => entry?.type === type);
  const attributes = section('TOP_ATTRIBUTES')?.attributes || [];
  const labelText = (predicate) => attributes.find((attr) => predicate(String(attr?.label || '')))?.text;

  // Cold rent (Kaltmiete) matches the German rental convention used by the
  // specification filter and is conservative for a maxPrice check; fall back to
  // warm rent only when cold is absent.
  const priceText = labelText((label) => /kaltmiete/i.test(label)) ?? labelText((label) => /warmmiete/i.test(label));
  const roomsText = labelText((label) => /^zimmer/i.test(label));
  const sizeText = labelText((label) => /wohnfl/i.test(label));

  const map = section('MAP');
  const addressLine1 = typeof map?.addressLine1 === 'string' ? map.addressLine1.trim() : '';
  const addressLine2 = typeof map?.addressLine2 === 'string' ? map.addressLine2.trim() : '';
  const addressValue = [addressLine1, addressLine2].filter(Boolean).join(', ') || null;

  // Only trust the expose coordinates when a house number is present. When
  // ImmoScout hides the exact address, addressLine1 is a bare street/district
  // and location is a centroid, which must not drive a confident area reject.
  const lat = Number(map?.location?.lat);
  const lng = Number(map?.location?.lng);
  const hasHouseNumber = /\d/.test(addressLine1);
  const coords =
    hasHouseNumber && Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng, precision: 'exact', source: 'immoscout-expose' }
      : null;

  const blacklistText = [section('TITLE')?.title, expose?.header?.title, addressLine1, addressLine2]
    .filter(Boolean)
    .join('\n');

  return {
    price: numberFrom(priceText, 'immoscout-expose', 'high'),
    size: numberFrom(sizeText, 'immoscout-expose', 'high'),
    rooms: numberFrom(roomsText, 'immoscout-expose', 'high'),
    address: addressValue ? { value: addressValue, source: 'immoscout-expose', confidence: 'high' } : EMPTY_STRING,
    coords,
    blacklistText,
  };
}

// --- Immowelt embedded classified (structured, high confidence) ---------------

function fromImmoweltClassified(embedded) {
  const entry = embedded.find((item) => item?.kind === '#__UFRN_LIFECYCLE_SERVERREQUEST__');
  const cls = entry?.value?.app_cldp?.data?.classified;
  if (!cls) return null;

  const tracking = cls.advertising?.tracking_config || {};
  const facts = Array.isArray(cls.sections?.hardFacts?.facts) ? cls.sections.hardFacts.facts : [];
  const trackingValue = (pattern) => {
    // Skip the *_Range / *_Bereich bucket keys (e.g. Wohnflaeche_Range "100-200").
    const key = Object.keys(tracking).find((name) => pattern.test(name) && !/range|bereich/i.test(name));
    return key ? tracking[key] : undefined;
  };
  const factValue = (pattern) => {
    const fact = facts.find((item) => pattern.test(String(item?.type || '')));
    return fact?.splitValue ?? fact?.value;
  };

  // Only trust the price for rentals: a sale Kaufpreis must not feed a rent maxPrice check.
  const isRent = /rent|miet/i.test(String(tracking.Vermarktungsart || cls.rawData?.distributionType || ''));
  const address = cls.sections?.location?.address || {};
  const street = [address.street, address.houseNumber].filter(Boolean).join(' ').trim();
  const cityLine = [address.zipCode, address.city].filter(Boolean).join(' ').trim();
  const addressValue = [street, cityLine].filter(Boolean).join(', ') || null;

  return {
    price: isRent ? numberFrom(trackingValue(/^preis$|kaltmiete|nettokalt/i), 'immowelt', 'high') : EMPTY_NUMBER,
    size: numberFrom(trackingValue(/wohnfl/i) ?? factValue(/livingspace|wohnfl/i), 'immowelt', 'high'),
    rooms: numberFrom(trackingValue(/zimmer|room/i) ?? factValue(/room|zimmer/i), 'immowelt', 'high'),
    address: addressValue ? { value: addressValue, source: 'immowelt', confidence: 'high' } : EMPTY_STRING,
    // Immowelt publishes an area polygon, not a rooftop point — geocode the
    // address instead (only precise/published addresses drive an area reject).
    coords: null,
    blacklistText: [cls.title, cls.sections?.mainDescription?.headline, street, address.city]
      .filter(Boolean)
      .join('\n'),
  };
}

// --- Generic schema.org JSON-LD (medium confidence) ---------------------------

function fromJsonLd(embedded) {
  const candidates = embedded
    .filter((entry) => entry?.kind === 'json-ld')
    .flatMap((entry) => flattenJsonLd(entry.value));
  const listing = candidates.find((node) => {
    const type = jsonLdTypes(node);
    return type.some((value) => /RealEstateListing|Residence|Apartment|SingleFamilyResidence|House/i.test(value));
  });
  if (!listing) return null;

  // AggregateOffer (e.g. a WG-Gesucht page listing many rooms) must never
  // become a single price — reject it outright.
  const offers = listing.offers;
  const offerType = jsonLdTypes(offers);
  const priceValue =
    offers && !offerType.some((value) => /AggregateOffer/i.test(value))
      ? (offers.price ?? offers.priceSpecification?.price)
      : null;

  const address = jsonLdAddress(listing.address);

  return {
    price: numberFrom(priceValue, 'json-ld', 'medium'),
    size: numberFrom(listing.floorSize?.value, 'json-ld', 'medium'),
    rooms: numberFrom(listing.numberOfRooms?.value ?? listing.numberOfRooms, 'json-ld', 'medium'),
    address: address ? { value: address, source: 'json-ld', confidence: 'medium' } : EMPTY_STRING,
    coords: null, // JSON-LD centroids are unreliable; geocode the address instead
    blacklistText: [listing.name, address].filter(Boolean).join('\n'),
  };
}

function flattenJsonLd(value) {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (value && typeof value === 'object') {
    const graph = Array.isArray(value['@graph']) ? value['@graph'].flatMap(flattenJsonLd) : [];
    return [value, ...graph];
  }
  return [];
}

function jsonLdTypes(node) {
  const type = node?.['@type'];
  if (Array.isArray(type)) return type.map(String);
  return type ? [String(type)] : [];
}

function jsonLdAddress(address) {
  if (!address) return null;
  if (typeof address === 'string') return address.trim() || null;
  const parts = [
    [address.streetAddress].filter(Boolean).join(' '),
    [address.postalCode, address.addressLocality].filter(Boolean).join(' '),
  ].filter(Boolean);
  return parts.join(', ') || null;
}

// --- Full-text regex fallback (low confidence, single-value only) -------------

const SIZE_PATTERNS = [/(\d{1,4}(?:[.,]\d{1,2})?)\s*m²/gi];
const ROOMS_PATTERNS = [/(\d{1,2}(?:[.,]\d)?)\s*(?:Zimmer|Zi\.?)\b/gi];
const PRICE_PATTERNS = [/(?:Kaltmiete|Nettokaltmiete|Grundmiete)\D{0,24}?(\d[\d.]{2,})\s*€/gi];

/**
 * Read a single unambiguous number from free text. Returns null when zero or
 * more than one distinct candidate is found, so it can never guess.
 */
function numberFromText(text, patterns, confidence) {
  if (!text) return EMPTY_NUMBER;
  const values = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = extractNumber(match[1]);
      if (value != null && value > 0) values.add(value);
    }
  }
  if (values.size !== 1) return EMPTY_NUMBER;
  return { value: [...values][0], source: 'fulltext', confidence };
}

function numberFrom(raw, source, confidence) {
  const value = extractNumber(raw);
  return value != null && value > 0 ? { value, source, confidence } : EMPTY_NUMBER;
}
