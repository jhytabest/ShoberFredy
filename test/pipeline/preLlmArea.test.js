/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it, vi } from 'vitest';

// Encode the scenario in the address string so the mocks stay declarative.
vi.mock('../../lib/services/geocoding/geoCodingService.js', () => ({
  geocodeAddress: async (address) => {
    if (String(address).includes('GEO_NULL')) return null; // geocoder unavailable
    if (String(address).includes('GEO_NOTFOUND')) return { lat: -1, lng: -1 }; // definitively not found
    return { lat: 51.0, lng: 6.0 }; // a point well outside the Berlin test polygon
  },
}));
vi.mock('../../lib/services/geocoding/geocodeCache.js', () => ({
  getCachedAccuracy: (_db, _keyFn, address) => {
    if (String(address).includes('DISTRICT')) return 'district';
    if (String(address).includes('POSTCODE')) return 'postcode';
    return 'house';
  },
}));
vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: { getConnection: () => ({}) },
}));

const { preLlmAreaReason } = await import('../../lib/services/pipeline/listingFilters.js');

// Square polygon around Berlin centre.
const berlinJob = {
  spatialFilter: {
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [13.3, 52.45],
              [13.5, 52.45],
              [13.5, 52.6],
              [13.3, 52.6],
              [13.3, 52.45],
            ],
          ],
        },
      },
    ],
  },
};

describe('preLlmAreaReason', () => {
  it('returns null when the job has no spatial polygons', async () => {
    expect(await preLlmAreaReason({}, { coords: { lat: 51, lng: 6, precision: 'exact' } }, {})).toBeNull();
  });

  it('accepts (null) an exact-coord listing inside the polygon without geocoding', async () => {
    const det = { coords: { lat: 52.52, lng: 13.4, precision: 'exact' } };
    expect(await preLlmAreaReason({}, det, berlinJob)).toBeNull();
  });

  it('rejects an exact-coord listing clearly outside the polygon', async () => {
    const det = { coords: { lat: 51.26, lng: 6.76, precision: 'exact' } };
    expect(await preLlmAreaReason({}, det, berlinJob)).toMatchObject({ code: 'area_filter', stage: 'pre_llm' });
  });

  it('rejects a precisely geocoded (house-level) out-of-area address', async () => {
    const det = { address: { value: 'HOUSE Musterstr. 1, 40468 Düsseldorf' } };
    expect(await preLlmAreaReason({}, det, berlinJob)).toMatchObject({ code: 'area_filter' });
  });

  it('never rejects on a coarse (district-level) geocode', async () => {
    const det = { address: { value: 'DISTRICT Düsseldorf' } };
    expect(await preLlmAreaReason({}, det, berlinJob)).toBeNull();
  });

  it('fails open when the geocoder is unavailable or the address is not found', async () => {
    expect(await preLlmAreaReason({}, { address: { value: 'GEO_NULL somewhere' } }, berlinJob)).toBeNull();
    expect(await preLlmAreaReason({}, { address: { value: 'GEO_NOTFOUND somewhere' } }, berlinJob)).toBeNull();
  });

  it('falls back to the discovery address when no deterministic address exists', async () => {
    expect(await preLlmAreaReason({ address: 'HOUSE Somewhere out' }, {}, berlinJob)).toMatchObject({
      code: 'area_filter',
    });
  });
});
