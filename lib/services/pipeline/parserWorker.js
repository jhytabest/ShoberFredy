/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import { env } from '../../shared/env.js';
import {
  completeParse,
  getExtraction,
  getQueueImages,
  saveExtraction,
  toParseRow,
  updateParseStage,
} from './queueStorage.js';
import { deferWork, registerHandler, retryWork, startWorker } from './workQueue.js';
import { canSpend, LlmBudgetExhaustedError } from './llmBudget.js';
import { analyzeImages, parseListingWithLlm } from './listingLlmParser.js';
import { finalizeLive, GeocodeDeferredError } from './listingFinalizer.js';
import { validateListing } from './listingSchema.js';

const WORKER_NAME = 'parser';

/**
 * @returns {string|null} worker name, or null when parsing is disabled
 */
export function startParserWorker() {
  registerHandler('parse', {
    name: WORKER_NAME,
    // Newest capture first. A rental that appeared minutes ago is the one a user
    // can still act on; a backlog item from yesterday has usually already been
    // let, so draining oldest-first spends the LLM budget on dead adverts.
    order: 'newest',
    enabled: parsingEnabled,
    // A valid item may need an initial text call plus one schema/evidence
    // correction call. Each request has its own 120-second deadline, so the
    // worker envelope must comfortably contain both and finalization.
    timeoutMs: () => env('FREDY_PARSER_ITEM_TIMEOUT_MS'),
    maxFailures: () => env('FREDY_PARSER_MAX_ITEM_FAILURES'),
    startedMessage: 'Continuous parser worker started.',
    // While the daily budget is spent, only items whose LLM answer is already
    // cached remain claimable: their finalization can still finish without
    // buying anything. Everything else waits rather than failing.
    claimFilter: () =>
      canSpend().ok
        ? null
        : {
            sql: `AND EXISTS (
                    SELECT 1 FROM listing_extractions e
                    WHERE e.queue_id = w.key AND e.llm_json IS NOT NULL
                  )`,
          },
    handler: (item, { signal }) => processQueueItem(toParseRow(item), { signal }),
  });
  return startWorker('parse');
}

function parsingEnabled() {
  if (!env('FREDY_PARSER_ENABLED')) return false;
  if (!env('FREDY_LLM_ENABLED')) {
    logger.warn('FREDY_LLM_ENABLED=0: parsing requires the LLM; the parser worker stays disabled.');
    return false;
  }
  return true;
}

/**
 * Process one claimed queue item: one required text request, then finalize.
 * Vision is disabled by default and strictly supplemental when enabled. Rate-limit
 * and geocode interruptions defer the item without any failure accounting —
 * the queue waits for the budget, it never bypasses it and never falls back.
 *
 * @param {object} queue parse work item in row shape
 * @returns {Promise<{status: string, listingId?: string|null, error?: Error}>}
 */
async function processQueueItem(queue, { signal } = {}) {
  const audit = {
    queueId: queue.id,
    listingId: queue.listing_id ?? null,
    provider: queue.provider,
  };
  const extraction = getExtraction(queue.id);

  let visual = extraction?.visual_json;
  let finalListing = extraction?.llm_json;
  if (finalListing && !validateListing(finalListing).valid) {
    finalListing = null;
    saveExtraction(queue.id, { llm_json: null, parsed_at: null });
  }

  try {
    // Vision is optional evidence. A vision failure is fully audited but can
    // never prevent the required text LLM extraction from running.
    if (!finalListing && env('FREDY_LLM_VISION_ENABLED') && !extraction?.vision_model) {
      try {
        const vision = await analyzeImages(getQueueImages(queue.id), { audit, signal });
        visual = vision?.summaries ?? null;
        saveExtraction(queue.id, {
          visual_json: visual,
          vision_model: vision?.model ?? 'none',
          vision_duration_ms: vision?.durationMs ?? null,
        });
      } catch (error) {
        if (error instanceof LlmBudgetExhaustedError) throw error;
        logger.warn(`Vision analysis failed for queue item '${queue.id}'; continuing text-only.`, error);
        saveExtraction(queue.id, { vision_model: 'failed' });
        visual = null;
      }
    } else if (!finalListing && !env('FREDY_LLM_VISION_ENABLED') && !extraction?.vision_model) {
      saveExtraction(queue.id, { vision_model: 'disabled' });
    }

    // Text stage: one request for every item, cached across retries.
    if (!finalListing) {
      const parsed = await parseListingWithLlm({ capture: queue.capture, visual, audit, signal });
      signal?.throwIfAborted();
      finalListing = parsed.listing;
      saveExtraction(queue.id, {
        llm_json: finalListing,
        text_model: parsed.model,
        llm_duration_ms: parsed.durationMs,
      });
      updateParseStage(
        queue.id,
        'llm',
        parsed.repairs?.length
          ? {
              action: 'normalized',
              reason: 'Mechanical model-output normalization',
              payload: { repairs: parsed.repairs },
            }
          : null,
      );
    }
  } catch (error) {
    if (error instanceof LlmBudgetExhaustedError) {
      deferWork('parse', queue.id, error.message, error.retryAtMs);
      return { status: 'deferred', error };
    }
    // The LLM failure budget is counted separately from the item's attempts: a
    // model that rejects one listing five times is a dead listing, while a
    // transient worker error is not.
    const outcome = retryWork('parse', queue.id, error, {
      counter: 'llmAttempts',
      maxFailures: env('FREDY_LLM_MAX_LISTING_FAILURES'),
      stage: 'llm',
      classification: { kind: 'llm_failure', llm: true },
    });
    if (outcome.status === 'dead') {
      logger.error(`Aborted parser queue item '${queue.id}' after repeated LLM failures.`, error);
      return { status: 'dead', error };
    }
    return { status: 'retry', error };
  }

  try {
    signal?.throwIfAborted();
    updateParseStage(queue.id, 'finalize');
    const allowMissingCoordinates = queue.geocode_attempt_count >= 4;
    const result = await finalizeLive(queue, finalListing, { allowMissingCoordinates, signal });
    signal?.throwIfAborted();
    saveExtraction(queue.id, { parsed_at: Date.now() });
    completeParse(queue.id, result.listingId, result.status);
    return result;
  } catch (error) {
    if (error instanceof GeocodeDeferredError) {
      // Two hours, not the shared ceiling: an address that failed to geocode is
      // waiting on a third party, and the listing is still live meanwhile.
      const untilMs = Date.now() + Math.min(2 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(queue.geocode_attempt_count, 6));
      deferWork('parse', queue.id, error.message, untilMs, { counter: 'geocodeAttempts' });
      return { status: 'deferred', error };
    }
    throw error;
  }
}
