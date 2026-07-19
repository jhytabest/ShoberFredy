/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('notification dispatcher', () => {
  let calls;
  let rows;
  let scores;
  let installedAdapters;

  beforeEach(() => {
    calls = { sent: [], failed: [], cancelled: [], adapters: [], listings: [] };
    rows = [];
    scores = new Map();
    installedAdapters = ['working', 'broken'];
  });

  async function loadDispatcher(job) {
    const root = path.resolve('.');
    vi.resetModules();
    vi.doMock(`${root}/lib/services/pipeline/notificationOutbox.js`, () => ({
      getDueDeliveries: () => rows,
      getListingScores: () => scores,
      markDeliveriesSent: (ids) => calls.sent.push(ids),
      markDeliveriesFailed: (ids) => calls.failed.push(ids),
      markDeliveriesCancelled: (ids) => calls.cancelled.push(ids),
    }));
    vi.doMock(`${root}/lib/services/storage/jobStorage.js`, () => ({ getJob: () => job }));
    vi.doMock(`${root}/lib/services/storage/settingsStorage.js`, () => ({
      getSettings: async () => ({ baseUrl: '' }),
    }));
    vi.doMock(`${root}/lib/notification/notify.js`, () => ({
      hasAdapter: (id) => installedAdapters.includes(id),
      send: (_provider, listings, adapters) => {
        calls.adapters.push(adapters[0].id);
        calls.listings.push(listings);
        if (adapters[0].id === 'broken') throw new Error('delivery failed');
        return [Promise.resolve()];
      },
    }));
    return await import('../../lib/services/pipeline/notificationDispatcher.js');
  }

  it('tracks each adapter independently so one failure cannot resend another', async () => {
    rows = [delivery('delivery-ok', 'working', 0), delivery('delivery-fail', 'broken', 1)];
    const dispatcher = await loadDispatcher({
      id: 'job-1',
      enabled: true,
      notificationAdapter: [{ id: 'working' }, { id: 'broken' }],
    });
    await dispatcher.dispatchDueNotifications();
    expect(calls.sent).toEqual([['delivery-ok']]);
    expect(calls.failed).toEqual([['delivery-fail']]);
    expect(calls.adapters).toEqual(['working', 'broken']);
  });

  it('cancels pending rows when the job is disabled', async () => {
    rows = [delivery('delivery-1', 'working', 0)];
    const dispatcher = await loadDispatcher({
      id: 'job-1',
      enabled: false,
      notificationAdapter: [{ id: 'working' }],
    });
    await dispatcher.dispatchDueNotifications();
    expect(calls.cancelled).toEqual([['delivery-1']]);
    expect(calls.adapters).toEqual([]);
  });

  it('cancels instead of falsely marking sent when the adapter module is missing', async () => {
    rows = [delivery('delivery-1', 'uninstalled', 0)];
    const dispatcher = await loadDispatcher({
      id: 'job-1',
      enabled: true,
      notificationAdapter: [{ id: 'uninstalled' }],
    });
    await dispatcher.dispatchDueNotifications();
    expect(calls.cancelled).toEqual([['delivery-1']]);
    expect(calls.sent).toEqual([]);
  });

  it('enriches digest listings with structured fields, comments, and the persisted score', async () => {
    rows = [
      {
        ...delivery('delivery-1', 'working', 0),
        listing_type: 'rental',
        property_type: 'apartment',
        cold_rent_eur: 900,
        warm_rent_eur: 1150,
        floor: 2,
        building_year: 1910,
        availability: 'date',
        available_from: '2026-09-01',
        furnished: 1,
        pets_allowed: 1,
        amenities_json: JSON.stringify(['balcony', 'elevator']),
        comments: 'Tausch nur gegen 3-Zimmer in Kreuzberg.',
      },
    ];
    scores = new Map([['listing-1', { actualPricePerSqm: 20, priceType: 'cold', swap: false, models: {} }]]);
    const dispatcher = await loadDispatcher({
      id: 'job-1',
      enabled: true,
      notificationAdapter: [{ id: 'working' }],
    });
    await dispatcher.dispatchDueNotifications();
    expect(calls.sent).toEqual([['delivery-1']]);
    const [listing] = calls.listings[0];
    expect(listing.address).toContain('rental');
    expect(listing.address).toContain('cold 900 €');
    expect(listing.address).toContain('available 2026-09-01');
    expect(listing.address).toContain('balcony, elevator');
    expect(listing.address).toContain('Tausch nur gegen 3-Zimmer in Kreuzberg.');
    expect(listing.marketScore).toEqual(scores.get('listing-1'));
  });
});

function delivery(id, adapterId, adapterOrdinal) {
  return {
    delivery_id: id,
    job_id: 'job-1',
    provider: 'immoscout',
    adapter_id: adapterId,
    adapter_ordinal: adapterOrdinal,
    manually_deleted: 0,
    hidden_reason: null,
    id: 'listing-1',
    title: 'Listing',
    price: 1000,
    size: 50,
    rooms: 2,
    address: 'Teststraße 1',
  };
}
