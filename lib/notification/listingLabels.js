/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
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

export function listingFactsGerman(row) {
  const facts = [];
  const push = (label, value) => {
    if (value != null && value !== '') facts.push({ label, value: String(value) });
  };
  const highlights = [];
  if (row.size != null) highlights.push(`${row.size} m²`);
  if (row.amenities?.includes('old_building')) highlights.push('Altbau');
  if (row.floor != null) highlights.push(row.floor === 0 ? 'EG' : `${row.floor}. OG`);
  if (row.amenities?.includes('balcony')) highlights.push('Balkon');
  if (row.amenities?.includes('terrace')) highlights.push('Terrasse');
  const condition = {
    well_maintained: 'gepflegt',
    renovated: 'renoviert',
    refurbished: 'saniert',
    like_new: 'neuwertig',
    first_occupancy_after_renovation: 'Erstbezug nach Sanierung',
  }[row.condition];
  if (condition) highlights.push(condition);
  push('Wohnung', highlights.join(' · '));
  push('Miete', rentLabel(row));
  if (row.mandatoryExtrasEur != null && row.mandatoryExtrasEur > 0)
    push('Weitere Pflichtkosten', `${fmtEur(row.mandatoryExtrasEur)} / Monat`);
  if (row.minimumTermMonths != null && row.minimumTermMonths > 0)
    push('Mindestmietdauer', `${row.minimumTermMonths} Monate`);
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
