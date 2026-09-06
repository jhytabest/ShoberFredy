/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { extractNumber } from '../../utils/extract-number.js';

const EMPTY_NUMBER = { value: null, source: 'none', confidence: 'low' };
const EMPTY_STRING = { value: null, source: 'none', confidence: 'low' };

export function extractDeterministicDetail(capture) {
  const embedded = Array.isArray(capture?.embeddedData) ? capture.embeddedData : [];
  const fullText = typeof capture?.fullText === 'string' ? capture.fullText : '';

  const structured = fromImmoscoutExpose(embedded) || fromJsonLd(embedded) || {};

  const price = structured.price ?? numberFromText(fullText, PRICE_PATTERNS, 'low');
  const size = structured.size ?? numberFromText(fullText, SIZE_PATTERNS, 'low');
  const rooms = structured.rooms ?? numberFromText(fullText, ROOMS_PATTERNS, 'low');
  const address = structured.address ?? EMPTY_STRING;
  return { price, size, rooms, address };
}

function fromImmoscoutExpose(embedded) {
  const expose = embedded.find((entry) => entry?.kind === 'immoscout-expose')?.value;
  const sections = Array.isArray(expose?.sections) ? expose.sections : null;
  if (!sections) return null;

  const section = (type) => sections.find((entry) => entry?.type === type);
  const attributes = section('TOP_ATTRIBUTES')?.attributes || [];
  const labelText = (predicate) => attributes.find((attr) => predicate(String(attr?.label || '')))?.text;

  const priceText = labelText((label) => /kaltmiete/i.test(label)) ?? labelText((label) => /warmmiete/i.test(label));
  const roomsText = labelText((label) => /^zimmer/i.test(label));
  const sizeText = labelText((label) => /wohnfl/i.test(label));

  const map = section('MAP');
  const addressLine1 = typeof map?.addressLine1 === 'string' ? map.addressLine1.trim() : '';
  const addressLine2 = typeof map?.addressLine2 === 'string' ? map.addressLine2.trim() : '';
  const addressValue = [addressLine1, addressLine2].filter(Boolean).join(', ') || null;

  return {
    price: numberFrom(priceText, 'immoscout-expose', 'high'),
    size: numberFrom(sizeText, 'immoscout-expose', 'high'),
    rooms: numberFrom(roomsText, 'immoscout-expose', 'high'),
    address: addressValue ? { value: addressValue, source: 'immoscout-expose', confidence: 'high' } : EMPTY_STRING,
  };
}

function fromJsonLd(embedded) {
  const candidates = embedded
    .filter((entry) => entry?.kind === 'json-ld')
    .flatMap((entry) => flattenJsonLd(entry.value));
  const listing = candidates.find((node) => {
    const type = jsonLdTypes(node);
    return type.some((value) => /RealEstateListing|Residence|Apartment|SingleFamilyResidence|House/i.test(value));
  });
  if (!listing) return null;

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

const SIZE_PATTERNS = [/(\d{1,4}(?:[.,]\d{1,2})?)\s*m²/gi];
const ROOMS_PATTERNS = [/(\d{1,2}(?:[.,]\d)?)\s*(?:Zimmer|Zi\.?)\b/gi];
const PRICE_PATTERNS = [/(?:Kaltmiete|Nettokaltmiete|Grundmiete)\D{0,24}?(\d[\d.]{2,})\s*€/gi];

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
