/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('notification dispatcher', () => {
  let calls;
  let rows;

  beforeEach(() => {
    calls = { sent: [], failed: [], cancelled: [], adapters: [] };
    rows = [];
  });

  async function loadDispatcher(job) {
    const root = path.resolve('.');
    vi.resetModules();
    vi.doMock(`${root}/lib/services/pipeline/notificationOutbox.js`, () => ({
      getDueDeliveries: () => rows,
      markDeliveriesSent: (ids) => calls.sent.push(ids),
      markDeliveriesFailed: (ids) => calls.failed.push(ids),
      markDeliveriesCancelled: (ids) => calls.cancelled.push(ids),
    }));
    vi.doMock(`${root}/lib/services/storage/jobStorage.js`, () => ({ getJob: () => job }));
    vi.doMock(`${root}/lib/services/storage/settingsStorage.js`, () => ({
      getSettings: async () => ({ baseUrl: '' }),
    }));
    vi.doMock(`${root}/lib/notification/notify.js`, () => ({
      send: (_provider, _listings, adapters) => {
        calls.adapters.push(adapters[0].id);
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
  };
}
