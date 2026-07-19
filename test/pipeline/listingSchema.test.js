/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import { validateListing } from '../../lib/services/pipeline/listingSchema.js';

const validListing = {
  title: 'Wohnung',
  listing_type: 'rental',
  address: null,
  availability: 'date',
  available_from: '2026-09-01',
  size_sqm: 50,
  rooms: 2,
  bedrooms: null,
  bathrooms: null,
  floor: null,
  total_floors: null,
  building_year: 1910,
  property_type: 'apartment',
  condition: 'renovated',
  furnished: null,
  rent: {
    cold: 900,
    warm: 1150,
    service_charges: 250,
    heating_costs: null,
    deposit: null,
    price_type: 'cold',
  },
  energy: { class: 'C', value_kwh: 95, heating_type: 'central' },
  pets_allowed: null,
  amenities: ['balcony', 'elevator'],
  comments: 'Tauschangebot: sucht 3 Zimmer in Kreuzberg.',
};

describe('listing LLM structure', () => {
  it('accepts the complete structure with enums, ISO date, and comments', () => {
    expect(validateListing(validListing)).toEqual({ valid: true, errors: [] });
  });

  it('accepts null for every optional fact', () => {
    const minimal = {
      ...validListing,
      address: null,
      availability: 'unknown',
      available_from: null,
      size_sqm: null,
      building_year: null,
      property_type: null,
      condition: null,
      rent: {
        cold: null,
        warm: null,
        service_charges: null,
        heating_costs: null,
        deposit: null,
        price_type: 'unknown',
      },
      energy: { class: null, value_kwh: null, heating_type: null },
      amenities: [],
      comments: null,
    };
    expect(validateListing(minimal)).toEqual({ valid: true, errors: [] });
  });

  it('rejects missing, extra, wrong-type, and invalid enum fields', () => {
    const invalid = structuredClone(validListing);
    delete invalid.address;
    invalid.rooms = 'two';
    invalid.listing_type = 'castle';
    invalid.unexpected = true;
    const result = validateListing(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('$.address is required');
    expect(result.errors.join('\n')).toContain('$.rooms must be number or null');
    expect(result.errors.join('\n')).toContain('$.listing_type has an invalid value');
    expect(result.errors.join('\n')).toContain('$.unexpected is not allowed');
  });

  it('rejects free-text availability and enforces the ISO date pairing', () => {
    const freeText = { ...validListing, availability: 'date', available_from: 'ab sofort' };
    expect(validateListing(freeText).errors.join('\n')).toContain('ISO date');

    const orphanDate = { ...validListing, availability: 'immediate', available_from: '2026-09-01' };
    expect(validateListing(orphanDate).errors.join('\n')).toContain('must be null unless availability');
  });

  it('rejects impossible calendar dates that Date.parse would normalize', () => {
    const impossible = { ...validListing, availability: 'date', available_from: '2026-02-31' };
    expect(validateListing(impossible).errors.join('\n')).toContain('ISO date');

    const leapDay = { ...validListing, availability: 'date', available_from: '2028-02-29' };
    expect(validateListing(leapDay)).toEqual({ valid: true, errors: [] });
    const nonLeapDay = { ...validListing, availability: 'date', available_from: '2027-02-29' };
    expect(validateListing(nonLeapDay).errors.join('\n')).toContain('ISO date');
  });

  it('rejects out-of-range numbers and off-vocabulary amenities', () => {
    const outOfRange = structuredClone(validListing);
    outOfRange.building_year = 24;
    outOfRange.rent.cold = -5;
    outOfRange.amenities = ['balcony', 'Südbalkon mit Blick'];
    const result = validateListing(outOfRange);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('$.building_year must be >= 1200');
    expect(result.errors.join('\n')).toContain('$.rent.cold must be >= 0');
    expect(result.errors.join('\n')).toContain('$.amenities[1] has an invalid value');
  });
});
