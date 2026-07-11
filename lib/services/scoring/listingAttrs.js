/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Structured-attribute extraction from stored listing text.
 *
 * Portals expose rich key facts (rent breakdown, floor, type, year) that the
 * providers flatten into title/description text. This module recovers them so
 * the market model, exporter, and notification scorer share one view of a
 * listing. Everything here is best-effort: a field is null when the text does
 * not state it unambiguously.
 *
 * Price semantics per provider (the `price` column):
 * - immoscout: cold rent (verified against Kaltmiete attribute lines)
 * - immowelt: cold rent (portal lists Kaltmiete on result cards)
 * - wgGesucht: total rent (portal shows Gesamtmiete on result cards)
 * - kleinanzeigen and the rest: whatever the poster wrote — unknown
 * The model handles 'warm'/'unknown' via dummies instead of guessing a
 * conversion; parsed Kaltmiete/Gesamtmiete lines override the default.
 */

const PROVIDER_PRICE_TYPE = {
  immoscout: 'cold',
  immowelt: 'cold',
  wgGesucht: 'warm',
  kleinanzeigen: 'unknown',
  einsAImmobilien: 'unknown',
  immobilienDe: 'unknown',
  wohnungsboerse: 'unknown',
};

const PROPERTY_TYPES = [
  ['maisonette', /maisonette/],
  ['penthouse', /penthouse/],
  ['dachgeschoss', /dachgeschoss|\bdg\b/],
  ['studio', /\bstudio\b|apartment.*1 zimmer|^1-zimmer/],
  ['altbau', /altbau/],
  ['neubau', /neubau/],
];

/**
 * Parse the first German-formatted number in a string ("1.234,56" -> 1234.56).
 * @param {string|null} text
 * @returns {number|null}
 */
export function parseGermanNumber(text) {
  if (text == null) return null;
  // Thousands-dot branch must require at least one dot group, otherwise it
  // greedily truncates plain numbers ("1999" -> "199").
  const match = String(text).match(/-?\d{1,3}(?:\.\d{3})+(?:,\d+)?|-?\d+(?:,\d+)?/);
  if (!match) return null;
  const value = Number.parseFloat(match[0].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/*
 * immoscout descriptions carry an ATTRIBUTE_LIST section rendered as
 * "Label: value" lines (see the provider's buildDescription). Collect every
 * such line; label matching below is prefix-based because labels vary
 * ("Kaltmiete", "Kaltmiete (zzgl. Nebenkosten)", "Wohnfläche ca.").
 */
function attributeLines(description) {
  const map = new Map();
  for (const rawLine of String(description || '').split('\n')) {
    const line = rawLine.trim();
    const separator = line.indexOf(':');
    if (separator < 2 || separator > 60) continue;
    const label = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (label && value && !map.has(label)) map.set(label, value);
  }
  return map;
}

function findAttr(attrs, prefixes) {
  for (const [label, value] of attrs) {
    if (prefixes.some((prefix) => label.startsWith(prefix))) return value;
  }
  return null;
}

function parseFloor(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (/\berdgeschoss\b|\beg\b/.test(t)) return 0;
  if (/\bsouterrain\b|\buntergeschoss\b/.test(t)) return -1;
  const numbered = t.match(/(\d{1,2})\s*\.\s*(?:geschoss|etage|og|obergeschoss)/);
  if (numbered) return Number.parseInt(numbered[1], 10);
  const plain = t.match(/^(\d{1,2})(?:\s*von\s*\d+|\s*\/\s*\d+)?$/);
  if (plain) return Number.parseInt(plain[1], 10);
  return null;
}

function parseRoomsFromText(text) {
  if (!text) return null;
  const match = String(text)
    .toLowerCase()
    .match(/(\d+(?:[.,]5)?)\s*[- ]?\s*(?:zimmer|raum|räume|zi\b|room)/);
  if (!match) return null;
  const value = Number.parseFloat(match[1].replace(',', '.'));
  return Number.isFinite(value) && value >= 1 && value <= 12 ? value : null;
}

function parsePropertyType(text) {
  const t = String(text || '').toLowerCase();
  for (const [name, pattern] of PROPERTY_TYPES) {
    if (pattern.test(t)) return name;
  }
  return null;
}

/**
 * Extract structured attributes (rent breakdown, rooms, floor, building year,
 * property type, swap flag, ...) from a stored listing.
 *
 * @param {{provider?: string, title?: string, description?: string, price?: number, size?: number, rooms?: number}} listing
 * @returns {{coldRentEur: number|null, warmRentEur: number|null, serviceChargesEur: number|null,
 *   heatingCostsEur: number|null, depositEur: number|null, priceType: string, rooms: number|null,
 *   floor: number|null, buildingYear: number|null, propertyType: string|null, energyClass: string|null,
 *   petsAllowed: boolean|null, availableFrom: string|null, swap: boolean}}
 */
export function parseListingAttrs(listing) {
  const provider = listing.provider || '';
  const title = String(listing.title || '');
  const description = String(listing.description || '');
  const attrs = attributeLines(description);
  const storedPrice = Number(listing.price);

  const coldAttr = parseGermanNumber(findAttr(attrs, ['kaltmiete', 'grundmiete', 'nettokaltmiete']));
  const warmAttr = parseGermanNumber(findAttr(attrs, ['gesamtmiete', 'warmmiete', 'total']));
  const serviceCharges = parseGermanNumber(findAttr(attrs, ['nebenkosten', 'betriebskosten']));
  const heatingCosts = parseGermanNumber(findAttr(attrs, ['heizkosten']));
  const deposit = parseGermanNumber(findAttr(attrs, ['kaution']));
  const buildingYear = parseGermanNumber(findAttr(attrs, ['baujahr']));
  const floorAttr = findAttr(attrs, ['etage', 'geschoss']);
  const typeAttr = findAttr(attrs, ['wohnungstyp', 'objekttyp', 'kategorie']);
  const energyClass = (findAttr(attrs, ['energieeffizienzklasse']) || '').match(/^[A-H]\+?/)?.[0] || null;
  const petsAttr = findAttr(attrs, ['haustiere']);

  // immowelt encodes floor + availability in the title ("…·9. Geschoss·frei ab 01.08.2026").
  const floor = floorAttr != null ? parseFloor(floorAttr) : parseFloor(title);
  const availableFrom =
    (description.match(/bezugsfrei ab:?\s*([^\n]+)/i) ||
      title.match(/frei ab\s+(sofort|\d{2}\.\d{2}\.\d{4})/i))?.[1]?.trim() || null;

  const rooms =
    Number.isFinite(Number(listing.rooms)) && Number(listing.rooms) > 0
      ? Number(listing.rooms)
      : (parseRoomsFromText(title) ?? parseRoomsFromText(description.slice(0, 400)));

  // Rent semantics: parsed attribute lines beat the provider default. A
  // stored price equal (±1) to a parsed line pins the semantics exactly.
  let priceType = PROVIDER_PRICE_TYPE[provider] || 'unknown';
  if (Number.isFinite(storedPrice) && storedPrice > 0) {
    if (coldAttr != null && Math.abs(storedPrice - coldAttr) <= 1) priceType = 'cold';
    else if (warmAttr != null && Math.abs(storedPrice - warmAttr) <= 1) priceType = 'warm';
  }

  let coldRentEur = coldAttr;
  let warmRentEur = warmAttr;
  if (coldRentEur == null && priceType === 'cold' && storedPrice > 0) coldRentEur = storedPrice;
  if (warmRentEur == null && priceType === 'warm' && storedPrice > 0) warmRentEur = storedPrice;
  if (coldRentEur == null && warmRentEur != null && serviceCharges != null && warmRentEur - serviceCharges > 0) {
    coldRentEur = warmRentEur - serviceCharges;
  }

  const haystack = `${title}\n${description}`.toLowerCase();

  return {
    coldRentEur,
    warmRentEur,
    serviceChargesEur: serviceCharges,
    heatingCostsEur: heatingCosts,
    depositEur: deposit,
    priceType,
    rooms: rooms ?? null,
    floor,
    buildingYear: buildingYear != null && buildingYear >= 1850 && buildingYear <= 2030 ? buildingYear : null,
    propertyType: parsePropertyType(typeAttr || title),
    energyClass,
    petsAllowed: petsAttr == null ? null : /^ja/i.test(petsAttr),
    availableFrom,
    swap: /tauschwohnung|wohnungstausch/.test(haystack),
  };
}
