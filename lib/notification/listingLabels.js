/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * German labels for the LLM enum vocabulary and a curated "most important
 * fields" builder for notifications. Kept in one place so notifications (and
 * later the UI) render the same readable labels instead of raw English tokens.
 */

const PROPERTY_TYPE_DE = {
  apartment: 'Wohnung',
  ground_floor_apartment: 'Erdgeschosswohnung',
  attic_apartment: 'Dachgeschosswohnung',
  penthouse: 'Penthouse',
  maisonette: 'Maisonette',
  loft: 'Loft',
  studio: 'Apartment',
  souterrain: 'Souterrain',
  house: 'Haus',
  shared_room: 'WG-Zimmer',
  other: 'Sonstige',
};

const AMENITY_DE = {
  balcony: 'Balkon',
  terrace: 'Terrasse',
  garden: 'Garten',
  garden_use: 'Gartennutzung',
  elevator: 'Aufzug',
  fitted_kitchen: 'EBK',
  cellar: 'Keller',
  parking: 'Stellplatz',
  garage: 'Garage',
  underground_parking: 'Tiefgarage',
  bathtub: 'Badewanne',
  guest_toilet: 'Gäste-WC',
  dishwasher: 'Spülmaschine',
  washing_machine: 'Waschmaschine',
  parquet: 'Parkett',
  underfloor_heating: 'Fußbodenheizung',
  old_building: 'Altbau',
  new_building: 'Neubau',
  barrier_free: 'barrierefrei',
  wheelchair_accessible: 'rollstuhlgerecht',
  fireplace: 'Kamin',
  wg_suitable: 'WG-geeignet',
};

function fmtEur(value) {
  return `${Math.round(Number(value)).toLocaleString('de-DE')} €`;
}

function rentLabel(row) {
  const parts = [];
  if (row.coldRentEur != null) parts.push(`kalt ${fmtEur(row.coldRentEur)}`);
  if (row.warmRentEur != null) parts.push(`warm ${fmtEur(row.warmRentEur)}`);
  if (parts.length) return parts.join(' · ');
  return row.price != null ? fmtEur(row.price) : null;
}

/**
 * `availableFrom` carries either a token or a date, and its shape says which —
 * the same single value the extraction now produces, read without a second
 * field to consult. A range reads as "ab X bis Y" instead of the bare
 * "Zeitraum" the old enum could offer, because both bounds are right here.
 */
function availabilityLabelDe(row) {
  const from = row.availableFrom;
  if (from == null || from === 'unknown') return null;
  if (from === 'immediate') return 'sofort';
  if (from === 'flexible') return 'flexibel';
  return row.availableUntil ? `ab ${from} bis ${row.availableUntil}` : `ab ${from}`;
}

function furnishingLabelDe(row) {
  if (row.furnishingStatus === 'partial') return 'teilmöbliert';
  if (row.furnishingStatus === 'full') return 'möbliert';
  if (row.furnishingStatus === 'none') return 'unmöbliert';
  return null;
}

function petsLabelDe(row) {
  if (row.petsPolicy === 'conditional') return 'Haustiere nach Absprache';
  if (row.petsPolicy === 'preferred_no') return 'Haustiere eher nicht';
  if (row.petsPolicy === 'prohibited') return 'keine Haustiere';
  if (row.petsPolicy === 'allowed') return 'Haustiere erlaubt';
  return null;
}

function amenitiesLabelDe(amenities, limit = 8) {
  if (!Array.isArray(amenities) || amenities.length === 0) return null;
  return amenities
    .slice(0, limit)
    .map((amenity) => AMENITY_DE[amenity] || String(amenity).replace(/_/g, ' '))
    .join(', ');
}

/**
 * The curated, ordered "most important fields" for a listing notification, as
 * {label, value} pairs with German labels. Only fields with a value appear.
 * @param {object} row outbox row (listing columns + joined listing_attributes)
 * @returns {{label: string, value: string}[]}
 */
export function listingFactsGerman(row) {
  const facts = [];
  const push = (label, value) => {
    if (value != null && value !== '') facts.push({ label, value: String(value) });
  };
  push('Miete', rentLabel(row));
  if (row.size != null) push('Größe', `${row.size} m²`);
  if (row.rooms != null) push('Zimmer', row.rooms);
  push('Typ', row.propertyType && row.propertyType !== 'unknown' ? PROPERTY_TYPE_DE[row.propertyType] : null);
  push('Verfügbar', availabilityLabelDe(row));
  if (row.depositEur != null) push('Kaution', fmtEur(row.depositEur));
  if (row.floor != null) push('Etage', row.floor);
  if (row.buildingYear != null) push('Baujahr', row.buildingYear);
  push('Möblierung', furnishingLabelDe(row));
  push('Haustiere', petsLabelDe(row));
  push('Ausstattung', amenitiesLabelDe(row.amenities));
  return facts;
}
