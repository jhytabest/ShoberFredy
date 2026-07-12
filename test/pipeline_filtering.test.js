/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, expect } from 'vitest';
import { mockFredy } from './utils.js';
import * as mockStore from './mocks/mockStore.js';
import { get as getLastNotification } from './mocks/mockNotification.js';

/*
 * Storage policy: every non-duplicate listing is stored; the job's filters
 * (blacklist, specs, spatial) only decide visibility via hidden_reason.
 * Duplicates are never stored.
 */

const neverSimilar = { checkAndAddEntry: () => false };

function baseProvider(listings, overrides = {}) {
  return {
    url: 'http://example.com',
    getListings: () => Promise.resolve(listings),
    normalize: (l) => l,
    filter: () => true,
    crawlFields: { id: 'id', title: 'title', address: 'address', price: 'price' },
    requiredFieldNames: ['id', 'title', 'address', 'price'],
    ...overrides,
  };
}

function baseJob(overrides = {}) {
  return {
    id: 'test-job',
    notificationAdapter: [{ id: 'console' }],
    specFilter: null,
    spatialFilter: null,
    blacklist: [],
    ...overrides,
  };
}

const insidePolygon = {
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ],
        ],
      },
    },
  ],
};

beforeEach(() => {
  mockStore.deletedIds.length = 0;
  mockStore.storedListings.length = 0;
});

describe('Save-all policy: filters decide visibility, not storage', () => {
  it('does not store listings the similarity cache flags as duplicates', async () => {
    const Fredy = await mockFredy();
    const alwaysSimilar = { checkAndAddEntry: () => true };
    const fredy = new Fredy(
      baseProvider([{ id: '1', title: 'test', address: 'addr', price: '100', link: 'http://example.com/1' }]),
      baseJob(),
      'test-provider-sim',
      alwaysSimilar,
      undefined,
    );

    await fredy.execute();

    expect(mockStore.storedListings).toHaveLength(0);
    expect(mockStore.deletedIds).toHaveLength(0);
  });

  it('stores listings outside the spatial filter hidden with area_filter', async () => {
    const Fredy = await mockFredy();
    const fredy = new Fredy(
      baseProvider([
        {
          id: '2',
          title: 'outside',
          address: 'addr',
          price: '100',
          latitude: 2,
          longitude: 2, // outside polygon
          link: 'http://example.com/2',
        },
      ]),
      baseJob({ spatialFilter: insidePolygon }),
      'test-provider-area',
      neverSimilar,
      undefined,
    );

    await fredy.execute();

    expect(mockStore.storedListings).toHaveLength(1);
    expect(mockStore.storedListings[0].hidden_reason).toBe('area_filter');
    expect(mockStore.deletedIds).toHaveLength(0);
  });

  it('stores listings without valid coordinates hidden with no_coordinates', async () => {
    const Fredy = await mockFredy();
    const fredy = new Fredy(
      baseProvider([
        {
          id: '3',
          title: 'no coords',
          address: null, // never geocoded → no geocode_unavailable marker
          price: '100',
          link: 'http://example.com/3',
        },
      ]),
      baseJob({ spatialFilter: insidePolygon }),
      'test-provider-nocoords',
      neverSimilar,
      undefined,
    );

    await fredy.execute();

    expect(mockStore.storedListings).toHaveLength(1);
    expect(mockStore.storedListings[0].hidden_reason).toBe('no_coordinates');
  });

  it('stores listings failing the spec filter hidden with spec_filter', async () => {
    const Fredy = await mockFredy();
    const fredy = new Fredy(
      baseProvider([{ id: '4', title: 'too pricey', address: 'addr', price: 3000, link: 'http://example.com/4' }]),
      baseJob({ specFilter: { maxPrice: 2500 } }),
      'test-provider-spec',
      neverSimilar,
      undefined,
    );

    await fredy.execute();

    expect(mockStore.storedListings).toHaveLength(1);
    expect(mockStore.storedListings[0].hidden_reason).toBe('spec_filter');
  });

  it('evaluates the blacklist on the enriched detail-page description', async () => {
    const Fredy = await mockFredy();
    const providerId = 'test-provider-blacklist-details';

    mockStore.setUserSettings({ provider_details: [providerId] });

    const provider = baseProvider(
      [
        {
          id: 'blacklisted',
          title: 'Eleganz trifft Raumkomfort',
          address: 'Other street',
          price: '600',
          link: 'http://example.com/blacklisted',
          description: 'clean snippet',
        },
      ],
      {
        // The blacklisted term only shows up on the detail page.
        fetchDetails: (listing) => Promise.resolve({ ...listing, description: 'Mit allkauf wird der Traum wahr.' }),
        crawlFields: { id: 'id', title: 'title', address: 'address', price: 'price', description: 'description' },
        requiredFieldNames: ['id', 'title', 'address', 'price', 'description'],
      },
    );

    const fredy = new Fredy(provider, baseJob({ blacklist: ['allkauf'] }), providerId, neverSimilar, undefined);

    await fredy.execute();
    mockStore.setUserSettings(null);

    expect(mockStore.storedListings).toHaveLength(1);
    expect(mockStore.storedListings[0].hidden_reason).toBe('blacklist');
  });

  it('stores blacklisted listings hidden and notifies only visible ones', async () => {
    const Fredy = await mockFredy();
    const provider = baseProvider([
      {
        id: 'kept',
        title: 'Nice flat',
        address: 'Some street',
        price: '500',
        link: 'http://example.com/kept',
        description: 'Cozy home',
      },
      {
        id: 'blacklisted',
        title: 'WG Zimmer in Mitte',
        address: 'Other street',
        price: '600',
        link: 'http://example.com/blacklisted',
        description: 'clean snippet',
      },
    ]);

    const fredy = new Fredy(
      provider,
      baseJob({ blacklist: ['wg'] }),
      'test-provider-visibility',
      neverSimilar,
      undefined,
    );

    const result = await fredy.execute();

    // Both listings are stored; the blacklisted one is hidden.
    expect(mockStore.storedListings).toHaveLength(2);
    const byLink = Object.fromEntries(mockStore.storedListings.map((l) => [l.link, l.hidden_reason ?? null]));
    expect(byLink['http://example.com/kept']).toBe(null);
    expect(byLink['http://example.com/blacklisted']).toBe('blacklist');

    // Only the visible listing is notified.
    expect(result).toBeInstanceOf(Array);
    expect(result.map((l) => l.link)).toEqual(['http://example.com/kept']);
    const notification = getLastNotification();
    const notifiedLinks = (notification?.payload ?? []).map((p) => p.link);
    expect(notifiedLinks).not.toContain('http://example.com/blacklisted');
  });

  it('short-circuits notification when every listing is hidden, but still stores them', async () => {
    const Fredy = await mockFredy();
    const fredy = new Fredy(
      baseProvider([
        { id: 'only', title: 'WG Zimmer frei', address: 'addr', price: '100', link: 'http://example.com/only' },
      ]),
      baseJob({ blacklist: ['wg'] }),
      'test-provider-allhidden',
      neverSimilar,
      undefined,
    );

    await fredy.execute();

    expect(mockStore.storedListings).toHaveLength(1);
    expect(mockStore.storedListings[0].hidden_reason).toBe('blacklist');
  });
});
