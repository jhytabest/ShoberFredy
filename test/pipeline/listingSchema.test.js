/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import { validateListing } from '../../lib/services/pipeline/listingSchema.js';

const validListing = {
  title: 'Wohnung',
  listing_type: 'apartment',
  address: null,
  available_from: null,
  size_sqm: 50,
  rooms: 2,
  bedrooms: null,
  bathrooms: null,
  floor: null,
  total_floors: null,
  building_year: null,
  property_type: null,
  condition: null,
  furnished: null,
  rent: {
    cold: 900,
    warm: null,
    service_charges: null,
    heating_costs: null,
    deposit: null,
    price_type: 'cold',
  },
  energy: { class: null, value_kwh: null, heating_type: null },
  pets_allowed: null,
  amenities: [],
};

describe('listing LLM structure', () => {
  it('accepts the complete nullable structure', () => {
    expect(validateListing(validListing)).toEqual({ valid: true, errors: [] });
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
});
