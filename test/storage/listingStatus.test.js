/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// We mock SqliteConnection so we can assert which SQL the storage layer
// runs and with which params, without spinning up a real SQLite DB.

const calls = {
  execute: [],
  query: [],
};

const sqliteMock = {
  execute: (sql, params) => {
    calls.execute.push({ sql, params });
    // Default: pretend 1 row was affected (so setListingStatus reports success).
    return { changes: 1 };
  },
  query: (sql, params) => {
    calls.query.push({ sql, params });
    // Return shape varies by test — overridden via queryHandler when needed.
    if (sqliteMock.__queryHandler) return sqliteMock.__queryHandler(sql, params);
    return [];
  },
  __queryHandler: null,
};

vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({
  default: sqliteMock,
}));

describe('listingsStorage.setListingStatus', () => {
  let listingsStorage;

  beforeEach(async () => {
    calls.execute.length = 0;
    calls.query.length = 0;
    sqliteMock.__queryHandler = null;
    listingsStorage = await import('../../lib/services/storage/listingsStorage.js');
  });

  it('runs an UPDATE storing a JSON payload with status and setAt', () => {
    const before = Date.now();
    const changes = listingsStorage.setListingStatus('listing-1', 'Applied');
    const after = Date.now();
    expect(changes).toBe(1);
    expect(calls.execute).toHaveLength(1);
    expect(calls.execute[0].sql).toMatch(/UPDATE listings SET status = @status WHERE id = @id/);
    expect(calls.execute[0].params.id).toBe('listing-1');
    const parsed = JSON.parse(calls.execute[0].params.status);
    expect(parsed.status).toBe('applied');
    expect(parsed.setAt).toBeGreaterThanOrEqual(before);
    expect(parsed.setAt).toBeLessThanOrEqual(after);
  });

  it('accepts null to clear the status (no JSON wrapping)', () => {
    listingsStorage.setListingStatus('listing-2', null);
    expect(calls.execute[0].params).toEqual({ id: 'listing-2', status: null });
  });

  it('rejects invalid statuses', () => {
    expect(() => listingsStorage.setListingStatus('listing-3', 'maybe')).toThrow(/Invalid listing status/);
    expect(calls.execute).toHaveLength(0);
  });

  it('returns 0 when no id is supplied (no SQL is run)', () => {
    const result = listingsStorage.setListingStatus(null, 'applied');
    expect(result).toBe(0);
    expect(calls.execute).toHaveLength(0);
  });
});

describe('listingsStorage.queryListings statusFilter', () => {
  let listingsStorage;

  beforeEach(async () => {
    calls.execute.length = 0;
    calls.query.length = 0;
    // Return empty rows for both the count and the page-fetch queries.
    sqliteMock.__queryHandler = (sql) => {
      if (/COUNT\(1\)/.test(sql)) return [{ cnt: 0 }];
      return [];
    };
    listingsStorage = await import('../../lib/services/storage/listingsStorage.js');
  });

  it("adds 'l.status IS NULL' to WHERE when statusFilter is 'none'", () => {
    listingsStorage.queryListings({ statusFilter: 'none', userId: 'u1', isAdmin: true });
    const pageQuery = calls.query.find((c) => !/COUNT\(1\)/.test(c.sql));
    expect(pageQuery.sql).toMatch(/\(l\.status IS NULL\)/);
  });

  it('extracts the inner status field via json_extract for a concrete status', () => {
    listingsStorage.queryListings({ statusFilter: 'applied', userId: 'u1', isAdmin: true });
    const pageQuery = calls.query.find((c) => !/COUNT\(1\)/.test(c.sql));
    expect(pageQuery.sql).toMatch(/json_extract\(l\.status, '\$\.status'\) = @statusValue/);
    expect(pageQuery.params.statusValue).toBe('applied');
  });

  it('ignores unknown statusFilter values silently', () => {
    listingsStorage.queryListings({ statusFilter: 'bogus', userId: 'u1', isAdmin: true });
    const pageQuery = calls.query.find((c) => !/COUNT\(1\)/.test(c.sql));
    expect(pageQuery.sql).not.toMatch(/status/i);
  });

  it('parses the JSON status payload of returned rows into an object', () => {
    sqliteMock.__queryHandler = (sql) => {
      if (/COUNT\(1\)/.test(sql)) return [{ cnt: 2 }];
      return [
        { id: 'a', status: JSON.stringify({ status: 'applied', setAt: 1700000000000 }) },
        { id: 'b', status: null },
      ];
    };
    const result = listingsStorage.queryListings({ userId: 'u1', isAdmin: true });
    expect(result.result[0].status).toEqual({ status: 'applied', setAt: 1700000000000 });
    expect(result.result[1].status).toBeNull();
  });
});

describe('listingsStorage.queryListings hiddenOnly', () => {
  let listingsStorage;

  beforeEach(async () => {
    calls.execute.length = 0;
    calls.query.length = 0;
    sqliteMock.__queryHandler = (sql) => {
      if (/COUNT\(1\)/.test(sql)) return [{ cnt: 0 }];
      return [];
    };
    listingsStorage = await import('../../lib/services/storage/listingsStorage.js');
  });

  it('filters by manually_deleted = 0 by default', () => {
    listingsStorage.queryListings({ userId: 'u1', isAdmin: true });
    const pageQuery = calls.query.find((c) => !/COUNT\(1\)/.test(c.sql));
    expect(pageQuery.sql).toMatch(/\(l\.manually_deleted = 0\)/);
  });

  it('filters by manually_deleted = 1 when hiddenOnly is true', () => {
    listingsStorage.queryListings({ userId: 'u1', isAdmin: true, hiddenOnly: true });
    const pageQuery = calls.query.find((c) => !/COUNT\(1\)/.test(c.sql));
    expect(pageQuery.sql).toMatch(/\(l\.manually_deleted = 1\)/);
    expect(pageQuery.sql).not.toMatch(/\(l\.manually_deleted = 0\)/);
  });
});

describe('listingsStorage.restoreListingsById', () => {
  let listingsStorage;

  beforeEach(async () => {
    calls.execute.length = 0;
    calls.query.length = 0;
    sqliteMock.__queryHandler = null;
    listingsStorage = await import('../../lib/services/storage/listingsStorage.js');
  });

  it('clears the manually_deleted flag for the given ids', () => {
    listingsStorage.restoreListingsById(['a', 'b']);
    expect(calls.execute).toHaveLength(1);
    expect(calls.execute[0].sql).toMatch(/UPDATE listings\s+SET manually_deleted = 0\s+WHERE id IN \(\?,\?\)/);
    expect(calls.execute[0].params).toEqual(['a', 'b']);
  });

  it('is a no-op when ids are missing or empty', () => {
    listingsStorage.restoreListingsById([]);
    listingsStorage.restoreListingsById(undefined);
    expect(calls.execute).toHaveLength(0);
  });
});

describe('listingsStorage.getListingById', () => {
  let listingsStorage;

  beforeEach(async () => {
    calls.execute.length = 0;
    calls.query.length = 0;
    listingsStorage = await import('../../lib/services/storage/listingsStorage.js');
  });

  it('parses the JSON status payload of the returned row', () => {
    sqliteMock.__queryHandler = () => [
      { id: 'a', status: JSON.stringify({ status: 'rejected', setAt: 1700000000001 }) },
    ];
    const row = listingsStorage.getListingById('a', 'u1', true);
    expect(row.status).toEqual({ status: 'rejected', setAt: 1700000000001 });
  });

  it('returns null status untouched', () => {
    sqliteMock.__queryHandler = () => [{ id: 'a', status: null }];
    const row = listingsStorage.getListingById('a', 'u1', true);
    expect(row.status).toBeNull();
  });

  it('returns null when no row is found', () => {
    sqliteMock.__queryHandler = () => [];
    const row = listingsStorage.getListingById('missing', 'u1', true);
    expect(row).toBeNull();
  });
});
