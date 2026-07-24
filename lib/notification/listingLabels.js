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
  furnished: 'möbliert',
  wg_suitable: 'WG-geeignet',
};

function fmtEur(value) {
  return `${Math.round(Number(value)).toLocaleString('de-DE')} €`;
}

function rentLabel(row) {
  const parts = [];
  if (row.cold_rent_eur != null) parts.push(`kalt ${fmtEur(row.cold_rent_eur)}`);
  if (row.warm_rent_eur != null) parts.push(`warm ${fmtEur(row.warm_rent_eur)}`);
  if (parts.length) return parts.join(' · ');
  return row.price != null ? fmtEur(row.price) : null;
}

function availabilityLabelDe(row) {
  if (row.availability === 'immediate') return 'sofort';
  if (row.availability === 'date' && row.available_from) return `ab ${row.available_from}`;
  if (row.availability === 'date_range') return 'Zeitraum';
  if (row.availability === 'flexible') return 'flexibel';
  return null;
}

function furnishingLabelDe(row) {
  if (row.furnishing_status === 'partial') return 'teilmöbliert';
  if (row.furnishing_status === 'full' || row.furnished === 1) return 'möbliert';
  if (row.furnishing_status === 'none') return 'unmöbliert';
  return null;
}

function petsLabelDe(row) {
  if (row.pets_policy === 'conditional') return 'Haustiere nach Absprache';
  if (row.pets_policy === 'preferred_no') return 'Haustiere eher nicht';
  if (row.pets_policy === 'prohibited' || row.pets_allowed === 0) return 'keine Haustiere';
  if (row.pets_policy === 'allowed' || row.pets_allowed === 1) return 'Haustiere erlaubt';
  return null;
}

function amenitiesLabelDe(amenitiesJson, limit = 8) {
  try {
    const amenities = JSON.parse(amenitiesJson || '[]');
    if (!Array.isArray(amenities) || amenities.length === 0) return null;
    return amenities
      .slice(0, limit)
      .map((amenity) => AMENITY_DE[amenity] || String(amenity).replace(/_/g, ' '))
      .join(', ');
  } catch {
    return null;
  }
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
  push('Typ', row.property_type && row.property_type !== 'unknown' ? PROPERTY_TYPE_DE[row.property_type] : null);
  push('Verfügbar', availabilityLabelDe(row));
  if (row.deposit_eur != null) push('Kaution', fmtEur(row.deposit_eur));
  if (row.floor != null) push('Etage', row.floor);
  if (row.building_year != null) push('Baujahr', row.building_year);
  push('Möblierung', furnishingLabelDe(row));
  push('Haustiere', petsLabelDe(row));
  push('Ausstattung', amenitiesLabelDe(row.amenities_json));
  return facts;
}
