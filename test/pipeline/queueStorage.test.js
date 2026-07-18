/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { up as migratePipeline } from '../../lib/services/storage/migrations/sql/27.decoupled-listing-pipeline.js';

describe('persistent parsing queues', () => {
  let db;
  let queue;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE jobs (id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE listings (
        id TEXT PRIMARY KEY, job_id TEXT, provider TEXT, hash TEXT, is_active INTEGER,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE TABLE settings (name TEXT, value TEXT);
      CREATE TABLE listing_attributes (listing_id TEXT PRIMARY KEY);
      INSERT INTO jobs (id, provider) VALUES ('job-1', '[]');
      INSERT INTO listings (id, job_id, provider, hash, is_active)
      VALUES ('listing-1', 'job-1', 'immoscout', 'old-hash', 1);
    `);
    migratePipeline(db);
    vi.resetModules();
    vi.doMock('../../lib/services/storage/SqliteConnection.js', () => ({
      default: {
        getConnection: () => db,
        query: (sql, params) => db.prepare(sql).all(params),
        execute: (sql, params) => db.prepare(sql).run(params),
        withTransaction: (callback) => db.transaction(() => callback(db))(),
      },
    }));
    queue = await import('../../lib/services/pipeline/queueStorage.js');
  });

  afterEach(() => {
    delete process.env.FREDY_BACKFILL_MAX_PER_MINUTE;
    delete process.env.FREDY_BACKFILL_MAX_PER_DAY;
    vi.resetModules();
    db.close();
  });

  it('deduplicates enqueueing, claims live first, and recovers expired leases', () => {
    const capture = sampleCapture('live');
    const liveId = queue.enqueueCapture({
      jobId: 'job-1',
      provider: 'immoscout',
      sourceHash: 'live-hash',
      capture,
    });
    expect(
      queue.enqueueCapture({
        jobId: 'job-1',
        provider: 'immoscout',
        sourceHash: 'live-hash',
        capture,
      }),
    ).toBe(liveId);
    queue.enqueueCapture({
      jobId: 'job-1',
      provider: 'immoscout',
      sourceHash: 'old-hash',
      capture: sampleCapture('backfill'),
      queueKind: 'backfill',
      listingId: 'listing-1',
    });

    expect(queue.claimNext({ now: 1000, leaseMs: 100 }).id).toBe(liveId);
    const reclaimed = queue.claimNext({ now: 1200, leaseMs: 100 });
    expect(reclaimed.id).toBe(liveId);
    queue.completeQueue(liveId, null);
    expect(queue.claimNext({ now: 1300, leaseMs: 100 }).queue_kind).toBe('backfill');
  });

  it('pauses backfill and enforces persistent per-minute attempt limits', () => {
    process.env.FREDY_BACKFILL_MAX_PER_MINUTE = '1';
    process.env.FREDY_BACKFILL_MAX_PER_DAY = '500';
    for (const suffix of ['a', 'b']) {
      db.prepare('INSERT INTO listings (id, job_id, provider, hash, is_active) VALUES (?, ?, ?, ?, 1)').run(
        `listing-${suffix}`,
        'job-1',
        'immoscout',
        `hash-${suffix}`,
      );
      queue.enqueueCapture({
        jobId: 'job-1',
        provider: 'immoscout',
        sourceHash: `hash-${suffix}`,
        capture: sampleCapture(suffix),
        queueKind: 'backfill',
        listingId: `listing-${suffix}`,
      });
    }
    queue.setBackfillPaused(true);
    expect(queue.claimNext({ now: 10_000 })).toBeNull();
    queue.setBackfillPaused(false);
    const first = queue.claimNext({ now: 10_000 });
    expect(first.queue_kind).toBe('backfill');
    queue.completeQueue(first.id, first.listing_id);
    expect(queue.claimNext({ now: 10_001 })).toBeNull();
    expect(queue.claimNext({ now: 70_001 })?.queue_kind).toBe('backfill');
  });
});

function sampleCapture(name) {
  return {
    externalId: name,
    sourceUrl: `https://example.test/${name}`,
    discoveredAt: 1,
    discoveryData: { title: name },
    fullText: `${name} full text`,
    embeddedData: [],
    images: [],
  };
}
