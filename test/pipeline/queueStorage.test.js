/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { up as migratePipeline } from '../../lib/services/storage/migrations/sql/27.decoupled-listing-pipeline.js';
import { up as migrateLlmOnly } from '../../lib/services/storage/migrations/sql/28.llm-only-structured-extraction.js';

describe('persistent parsing queues', () => {
  let db;
  let queue;
  let budget;

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
    migrateLlmOnly(db);
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
    budget = await import('../../lib/services/pipeline/llmBudget.js');
  });

  afterEach(() => {
    delete process.env.FREDY_LLM_DAILY_LIMIT;
    delete process.env.FREDY_LLM_BACKFILL_SHARE;
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
    // Reclaiming an expired lease counts as one (suspicious) attempt.
    expect(reclaimed.attempt_count).toBe(1);
    queue.completeQueue(liveId, null);
    expect(queue.claimNext({ now: 1300, leaseMs: 100 }).queue_kind).toBe('backfill');
  });

  it('supersedes unfinished rows from older schema versions on re-enqueue', () => {
    db.prepare(
      `INSERT INTO parsing_queue (id, queue_kind, schema_version, job_id, provider, source_hash,
         discovered_at, capture_json, status, created_at, updated_at)
       VALUES ('old-row', 'backfill', 1, 'job-1', 'immoscout', 'old-hash', 1, '{}', 'pending', 1, 1)`,
    ).run();
    const newId = queue.enqueueCapture({
      jobId: 'job-1',
      provider: 'immoscout',
      sourceHash: 'old-hash',
      capture: sampleCapture('v2'),
      queueKind: 'backfill',
      listingId: 'listing-1',
    });
    expect(newId).not.toBe('old-row');
    const oldRow = db.prepare("SELECT status FROM parsing_queue WHERE id = 'old-row'").get();
    expect(oldRow.status).toBe('cancelled');
  });

  it('revives dead backfill rows on re-enqueue', () => {
    const id = queue.enqueueCapture({
      jobId: 'job-1',
      provider: 'immoscout',
      sourceHash: 'old-hash',
      capture: sampleCapture('backfill'),
      queueKind: 'backfill',
      listingId: 'listing-1',
    });
    queue.markQueueDead(id, new Error('poison'));
    const revived = queue.enqueueCapture({
      jobId: 'job-1',
      provider: 'immoscout',
      sourceHash: 'old-hash',
      capture: sampleCapture('backfill'),
      queueKind: 'backfill',
      listingId: 'listing-1',
    });
    expect(revived).toBe(id);
    const row = db.prepare('SELECT status, attempt_count FROM parsing_queue WHERE id = ?').get(id);
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(0);
  });

  it('claims nothing needing LLM work while the budget is exhausted, but still claims cached items', () => {
    process.env.FREDY_LLM_DAILY_LIMIT = '1';
    const now = Date.UTC(2026, 6, 19, 12);
    budget.reserveLlmCall('live', now);

    const needsLlm = queue.enqueueCapture({
      jobId: 'job-1',
      provider: 'immoscout',
      sourceHash: 'needs-llm',
      capture: sampleCapture('a'),
    });
    expect(queue.claimNext({ now })).toBeNull();

    // An item whose extraction is already cached is claimable regardless.
    queue.saveExtraction(needsLlm, { llm_json: { title: 'done' } });
    expect(queue.claimNext({ now })?.id).toBe(needsLlm);
  });

  it('caps backfill at its budget share while live keeps the full budget', () => {
    process.env.FREDY_LLM_DAILY_LIMIT = '4';
    process.env.FREDY_LLM_BACKFILL_SHARE = '0.5';
    const now = Date.UTC(2026, 6, 19, 12);

    budget.reserveLlmCall('backfill', now);
    budget.reserveLlmCall('backfill', now);
    expect(budget.canSpend('backfill', now).ok).toBe(false);
    expect(budget.canSpend('live', now).ok).toBe(true);
    expect(() => budget.reserveLlmCall('backfill', now)).toThrow(budget.LlmBudgetExhaustedError);

    queue.enqueueCapture({
      jobId: 'job-1',
      provider: 'immoscout',
      sourceHash: 'old-hash',
      capture: sampleCapture('backfill'),
      queueKind: 'backfill',
      listingId: 'listing-1',
    });
    expect(queue.claimNext({ now })).toBeNull();

    // Live claims are unaffected until the total budget is gone.
    const liveId = queue.enqueueCapture({
      jobId: 'job-1',
      provider: 'immoscout',
      sourceHash: 'live-hash',
      capture: sampleCapture('live'),
    });
    expect(queue.claimNext({ now })?.id).toBe(liveId);

    // The next UTC day frees the backfill share again.
    const tomorrow = now + 24 * 60 * 60 * 1000;
    expect(budget.canSpend('backfill', tomorrow).ok).toBe(true);
  });

  it('blocks all LLM work until the upstream reset after a 429', () => {
    const now = Date.UTC(2026, 6, 19, 12);
    const reset = now + 60 * 60 * 1000;
    const until = budget.noteUpstreamExhausted(reset, now);
    expect(until).toBeGreaterThanOrEqual(reset);
    expect(budget.canSpend('live', now).ok).toBe(false);
    expect(budget.canSpend('live', until + 1).ok).toBe(true);
  });

  it('defers without failure accounting while retries count attempts', () => {
    const id = queue.enqueueCapture({
      jobId: 'job-1',
      provider: 'immoscout',
      sourceHash: 'live-hash',
      capture: sampleCapture('live'),
    });
    queue.deferQueue(id, 'Waiting for budget', Date.now() + 60_000);
    let row = db.prepare('SELECT status, attempt_count, llm_attempt_count FROM parsing_queue WHERE id = ?').get(id);
    expect(row.status).toBe('retry');
    expect(row.attempt_count).toBe(0);

    queue.retryQueue(id, new Error('boom'), { llm: true });
    row = db.prepare('SELECT attempt_count, llm_attempt_count FROM parsing_queue WHERE id = ?').get(id);
    expect(row.attempt_count).toBe(1);
    expect(row.llm_attempt_count).toBe(1);
  });

  it('pauses backfill via the control flag', () => {
    queue.enqueueCapture({
      jobId: 'job-1',
      provider: 'immoscout',
      sourceHash: 'old-hash',
      capture: sampleCapture('backfill'),
      queueKind: 'backfill',
      listingId: 'listing-1',
    });
    queue.setBackfillPaused(true);
    expect(queue.claimNext({ now: 10_000 })).toBeNull();
    queue.setBackfillPaused(false);
    expect(queue.claimNext({ now: 10_000 })?.queue_kind).toBe('backfill');
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
