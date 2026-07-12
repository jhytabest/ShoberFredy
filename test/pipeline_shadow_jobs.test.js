/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { expect } from 'vitest';
import { mockFredy } from './utils.js';
import * as mockStore from './mocks/mockStore.js';

const neverSimilarCache = {
  checkAndAddEntry: () => false,
};

function providerConfig(listing) {
  return {
    url: 'http://example.com',
    getListings: () => Promise.resolve([listing]),
    normalize: (l) => l,
    filter: () => true,
    crawlFields: { id: 'id', title: 'title', address: 'address', price: 'price' },
    requiredFieldNames: ['id', 'title', 'address', 'price'],
  };
}

const listing = { id: 'shadow-1', title: 'test', address: 'addr', price: '100', link: 'http://example.com/1' };

describe('Shadow jobs: listings are stored but immediately soft-hidden', () => {
  it('soft-hides freshly saved listings of a job without notification adapters', async () => {
    const Fredy = await mockFredy();
    const job = { id: 'shadow-job', notificationAdapter: [], specFilter: null, spatialFilter: null };
    const fredy = new Fredy(providerConfig(listing), job, 'test-provider', neverSimilarCache, undefined);

    mockStore.deletedIds.length = 0;
    try {
      await fredy.execute();
    } catch {
      // NoNewListingsWarning is fine
    }

    expect(mockStore.deletedIds).toContain('shadow-1');
  });

  it('does not hide listings of a job with notification adapters', async () => {
    const Fredy = await mockFredy();
    const job = {
      id: 'main-job',
      notificationAdapter: [{ id: 'console' }],
      specFilter: null,
      spatialFilter: null,
    };
    const fredy = new Fredy(
      providerConfig({ ...listing, id: 'main-1' }),
      job,
      'test-provider',
      neverSimilarCache,
      undefined,
    );

    mockStore.deletedIds.length = 0;
    try {
      await fredy.execute();
    } catch {
      // NoNewListingsWarning is fine
    }

    expect(mockStore.deletedIds).not.toContain('main-1');
  });
});
