/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TOOL = {
  type: 'function',
  function: { name: 'submit_listing', parameters: { type: 'object', properties: {} } },
};

describe('openRouterToolCall rate-limit handling', () => {
  let db;
  let client;
  let budget;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE pipeline_control (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE llm_budget_usage (day INTEGER NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, kind));
    `);
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.resetModules();
    vi.doMock('../../lib/services/storage/SqliteConnection.js', () => ({
      default: {
        getConnection: () => db,
        query: (sql, params) => db.prepare(sql).all(params),
        execute: (sql, params) => db.prepare(sql).run(params),
        withTransaction: (callback) => db.transaction(() => callback(db))(),
      },
    }));
    client = await import('../../lib/services/pipeline/openRouterClient.js');
    budget = await import('../../lib/services/pipeline/llmBudget.js');
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    vi.unstubAllGlobals();
    vi.resetModules();
    db.close();
  });

  function stub429(headers) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        text: async () => '{"error":{"message":"Rate limit exceeded"}}',
      })),
    );
  }

  it('normalizes a seconds-based x-ratelimit-reset to ms and blocks until then', async () => {
    const resetSeconds = Math.floor(Date.now() / 1000) + 1800;
    stub429({ 'x-ratelimit-reset': String(resetSeconds) });
    const call = client.openRouterToolCall({ model: 'm', messages: [], tool: TOOL, budgetKind: 'live' });
    await expect(call).rejects.toMatchObject({ name: 'LlmBudgetExhaustedError' });
    const blockedUntil = budget.budgetStatus().blockedUntil;
    // Seconds misread as ms would land in 1970 and leave no block at all.
    expect(blockedUntil).toBeGreaterThanOrEqual(resetSeconds * 1000);
    expect(budget.canSpend('live').ok).toBe(false);
  });

  it('accepts a milliseconds-based reset as-is', async () => {
    const resetMs = Date.now() + 30 * 60 * 1000;
    stub429({ 'x-ratelimit-reset': String(resetMs) });
    const call = client.openRouterToolCall({ model: 'm', messages: [], tool: TOOL, budgetKind: 'live' });
    await expect(call).rejects.toMatchObject({ name: 'LlmBudgetExhaustedError' });
    expect(budget.budgetStatus().blockedUntil).toBeGreaterThanOrEqual(resetMs);
  });
});
