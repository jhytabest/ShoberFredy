/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as similarityCache from '../lib/services/similarity-check/similarityCache.js';
import { capturedQueue, mockFredy } from './utils.js';
import * as mockStore from './mocks/mockStore.js';

describe('decoupled scrape producer', () => {
  beforeEach(() => {
    capturedQueue.splice(0);
    mockStore.storedListings.splice(0);
  });

  it('captures and enqueues without saving, geocoding, or notifying', async () => {
    const captureDetails = vi.fn(async (listing) => ({
      provider: 'test-provider',
      externalId: listing.id,
      sourceUrl: listing.link,
      discoveredAt: listing.discoveredAt,
      discoveryData: listing,
      fullText: 'Complete listing detail text',
      embeddedData: [{ kind: 'test', value: { rent: 1000 } }],
      images: [],
    }));
    const providerConfig = {
      url: 'https://example.test/search',
      sortByDateParam: null,
      requiredFieldNames: ['id', 'link', 'title'],
      getListings: async () => [{ id: 'source-1', link: 'https://example.test/1', title: 'Flat' }],
      normalize: (listing) => listing,
      filter: () => true,
      captureDetails,
    };
    const Fredy = await mockFredy();
    const fredy = new Fredy(
      providerConfig,
      { id: 'job-1', notificationAdapter: [], spatialFilter: null, specFilter: null },
      'test-provider',
      similarityCache,
      undefined,
    );

    const result = await fredy.execute();
    expect(result).toHaveLength(1);
    expect(captureDetails).toHaveBeenCalledOnce();
    expect(capturedQueue).toHaveLength(1);
    expect(capturedQueue[0].capture.fullText).toBe('Complete listing detail text');
    expect(mockStore.storedListings).toHaveLength(0);
  });
});
