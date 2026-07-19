/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('parser worker', () => {
  let calls;
  let extraction;
  let llmBehavior;
  let visionBehavior;

  beforeEach(() => {
    calls = { deferred: [], retried: [], completed: [], vision: [], llm: [], finalized: [] };
    extraction = null;
    llmBehavior = async () => ({ listing: { title: 'ok' }, model: 'text-model', durationMs: 5 });
    visionBehavior = async () => ({
      model: 'vision-model',
      summaries: [{ summary: 's', observations: [] }],
      durationMs: 3,
    });
  });

  async function loadWorker() {
    const root = path.resolve('.');
    vi.resetModules();
    vi.doMock(`${root}/lib/services/pipeline/queueStorage.js`, () => ({
      claimNext: () => null,
      completeQueue: (id, listingId, status) => calls.completed.push({ id, listingId, status }),
      deferQueue: (id, reason, untilMs, options) => calls.deferred.push({ id, reason, untilMs, options }),
      getExtraction: () => extraction,
      getQueueImages: () => [],
      retryQueue: (id, error, options) => calls.retried.push({ id, options }),
      saveExtraction: (id, patch) => {
        extraction = { ...(extraction || {}), ...patch };
      },
      updateQueueStage: () => {},
    }));
    vi.doMock(`${root}/lib/services/pipeline/listingLlmParser.js`, () => ({
      analyzeImages: (...args) => {
        calls.vision.push(args[1]);
        return visionBehavior();
      },
      parseListingWithLlm: (input) => {
        calls.llm.push(input.budgetKind);
        return llmBehavior(input);
      },
    }));
    vi.doMock(`${root}/lib/services/pipeline/listingFinalizer.js`, () => ({
      GeocodeDeferredError: class GeocodeDeferredError extends Error {},
      finalizeLive: async (queue) => {
        calls.finalized.push({ kind: 'live', id: queue.id });
        return { status: 'completed', listingId: 'listing-1' };
      },
      finalizeBackfill: async (queue) => {
        calls.finalized.push({ kind: 'backfill', id: queue.id });
        return { status: 'completed', listingId: queue.listing_id };
      },
    }));
    return await import('../../lib/services/pipeline/parserWorker.js');
  }

  function queueItem(overrides = {}) {
    return {
      id: 'queue-1',
      queue_kind: 'live',
      job_id: 'job-1',
      provider: 'immoscout',
      source_hash: 'hash-1',
      attempt_count: 0,
      llm_attempt_count: 0,
      geocode_attempt_count: 0,
      capture: { fullText: 'text', discoveryData: {}, images: [] },
      ...overrides,
    };
  }

  it('runs mandatory text parsing with vision disabled by default', async () => {
    const worker = await loadWorker();
    const result = await worker.processQueueItem(queueItem());
    expect(result.status).toBe('completed');
    expect(calls.vision).toEqual([]);
    expect(calls.llm).toEqual(['live']);
    expect(calls.finalized).toEqual([{ kind: 'live', id: 'queue-1' }]);
  });

  it('parses backfill items text-only', async () => {
    const worker = await loadWorker();
    await worker.processQueueItem(queueItem({ queue_kind: 'backfill', listing_id: 'listing-9' }));
    expect(calls.vision).toEqual([]);
    expect(calls.llm).toEqual(['backfill']);
    expect(calls.finalized).toEqual([{ kind: 'backfill', id: 'queue-1' }]);
  });

  it('defers without failure accounting when the LLM budget is exhausted', async () => {
    const worker = await loadWorker();
    // Import after loadWorker so the class comes from the same module registry.
    const { LlmBudgetExhaustedError } = await import('../../lib/services/pipeline/llmBudget.js');
    llmBehavior = async () => {
      throw new LlmBudgetExhaustedError('Daily LLM budget exhausted', 1234567);
    };
    const result = await worker.processQueueItem(queueItem());
    expect(result.status).toBe('deferred');
    expect(calls.deferred).toHaveLength(1);
    expect(calls.deferred[0].untilMs).toBe(1234567);
    expect(calls.retried).toEqual([]);
  });

  it('retries genuine LLM failures indefinitely', async () => {
    llmBehavior = async () => {
      throw new Error('model returned garbage');
    };
    const worker = await loadWorker();
    const retry = await worker.processQueueItem(queueItem({ llm_attempt_count: 0 }));
    expect(retry.status).toBe('retry');
    expect(calls.retried[0].options.llm).toBe(true);

    const laterRetry = await worker.processQueueItem(queueItem({ llm_attempt_count: 20 }));
    expect(laterRetry.status).toBe('retry');
    expect(calls.retried).toHaveLength(2);
  });

  it('reuses the cached extraction instead of new LLM calls on finalize retries', async () => {
    extraction = {
      source_text: 'text',
      llm_json: validCachedListing(),
      visual_json: null,
      vision_model: 'none',
    };
    const worker = await loadWorker();
    const result = await worker.processQueueItem(queueItem());
    expect(result.status).toBe('completed');
    expect(calls.vision).toEqual([]);
    expect(calls.llm).toEqual([]);
  });
});

function validCachedListing() {
  return {
    title: 'cached',
    listing_type: 'rental',
    address: null,
    availability: 'unknown',
    available_from: null,
    size_sqm: null,
    rooms: null,
    bedrooms: null,
    bathrooms: null,
    floor: null,
    total_floors: null,
    building_year: null,
    property_type: null,
    condition: null,
    furnished: null,
    rent: {
      cold: null,
      warm: null,
      service_charges: null,
      heating_costs: null,
      deposit: null,
      price_type: 'unknown',
    },
    energy: { class: null, value_kwh: null, heating_type: null },
    pets_allowed: null,
    amenities: [],
    comments: null,
  };
}
