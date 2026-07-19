/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import {
  claimNext,
  completeQueue,
  deferQueue,
  getExtraction,
  getQueueImages,
  retryQueue,
  saveExtraction,
  updateQueueStage,
} from './queueStorage.js';
import { LlmBudgetExhaustedError } from './llmBudget.js';
import { analyzeImages, parseListingWithLlm } from './listingLlmParser.js';
import { finalizeBackfill, finalizeLive, GeocodeDeferredError } from './listingFinalizer.js';
import { validateListing } from './listingSchema.js';

let stopped = false;

export function startParserWorker() {
  if (process.env.FREDY_PARSER_ENABLED === '0') {
    logger.info('Continuous parser worker is disabled.');
    return;
  }
  if (process.env.FREDY_LLM_ENABLED === '0') {
    logger.warn('FREDY_LLM_ENABLED=0: parsing requires the LLM; the parser worker stays disabled.');
    return;
  }
  stopped = false;
  void runLoop();
  logger.info('Continuous parser worker started.');
}

export function stopParserWorker() {
  stopped = true;
}

async function runLoop() {
  const idleMs = positiveEnv('FREDY_PARSER_IDLE_POLL_MS', 1000);
  while (!stopped) {
    let queue = null;
    try {
      queue = claimNext();
      if (!queue) {
        await delay(idleMs);
        continue;
      }
      await processQueueItem(queue);
    } catch (error) {
      try {
        if (queue) {
          logger.error(`Unexpected parser failure for queue item '${queue.id}'`, error);
          retryQueue(queue.id, error, { delayMs: retryDelay(queue.attempt_count) });
        } else {
          logger.error('Parser worker iteration failed before claiming an item', error);
          await delay(idleMs);
        }
      } catch (recoveryError) {
        // Never let bookkeeping kill the loop: back off and keep running.
        logger.error('Parser worker failed to record a queue failure; continuing.', recoveryError);
        await delay(idleMs);
      }
    }
  }
}

/**
 * Process one claimed queue item: one required text request, then finalize.
 * Vision is disabled by default and strictly supplemental when enabled. Rate-limit
 * and geocode interruptions defer the item without any failure accounting —
 * the queue waits for the budget, it never bypasses it and never falls back.
 *
 * @param {object} queue hydrated parsing_queue row
 * @returns {Promise<{status: string, listingId?: string|null, error?: Error}>}
 */
export async function processQueueItem(queue) {
  const budgetKind = queue.queue_kind === 'backfill' ? 'backfill' : 'live';
  const audit = {
    queueId: queue.id,
    listingId: queue.listing_id ?? null,
    provider: queue.provider,
  };
  const extraction = getExtraction(queue.id);
  if (!extraction?.source_text) {
    saveExtraction(queue.id, { source_text: queue.capture.fullText || '' });
  }

  let visual = extraction?.visual_json;
  let finalListing = extraction?.llm_json;
  if (finalListing && !validateListing(finalListing).valid) {
    finalListing = null;
    saveExtraction(queue.id, { llm_json: null, parsed_at: null });
  }

  try {
    // Vision is optional evidence. A vision failure is fully audited but can
    // never prevent the required text LLM extraction from running.
    if (!finalListing && budgetKind === 'live' && visionEnabled() && !extraction?.vision_model) {
      try {
        const vision = await analyzeImages(getQueueImages(queue.id), { budgetKind, audit });
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
    } else if (!finalListing && budgetKind === 'live' && !visionEnabled() && !extraction?.vision_model) {
      saveExtraction(queue.id, { vision_model: 'disabled' });
    }

    // Text stage: one request for every item, cached across retries.
    if (!finalListing) {
      const parsed = await parseListingWithLlm({ capture: queue.capture, visual, budgetKind, audit });
      finalListing = parsed.listing;
      saveExtraction(queue.id, {
        llm_json: finalListing,
        text_model: parsed.model,
        llm_duration_ms: parsed.durationMs,
      });
      updateQueueStage(queue.id, 'llm');
    }
  } catch (error) {
    if (error instanceof LlmBudgetExhaustedError) {
      deferQueue(queue.id, error.message, error.retryAtMs);
      return { status: 'deferred', error };
    }
    retryQueue(queue.id, error, { delayMs: retryDelay(queue.llm_attempt_count), llm: true });
    return { status: 'retry', error };
  }

  try {
    updateQueueStage(queue.id, 'finalize');
    const allowMissingCoordinates = queue.geocode_attempt_count >= 4;
    const result =
      queue.queue_kind === 'backfill'
        ? await finalizeBackfill(queue, finalListing, { allowMissingCoordinates })
        : await finalizeLive(queue, finalListing, { allowMissingCoordinates });
    saveExtraction(queue.id, { parsed_at: Date.now() });
    completeQueue(queue.id, result.listingId, result.status);
    return result;
  } catch (error) {
    if (error instanceof GeocodeDeferredError) {
      const delayMs = Math.min(2 * 60 * 60 * 1000, retryDelay(queue.geocode_attempt_count));
      deferQueue(queue.id, error.message, Date.now() + delayMs, { geocode: true });
      return { status: 'deferred', error };
    }
    throw error;
  }
}

function retryDelay(attempt) {
  const base = Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(Math.max(attempt, 0), 9));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function visionEnabled() {
  return process.env.FREDY_LLM_VISION_ENABLED === '1';
}

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
