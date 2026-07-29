/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import {
  claimNext,
  completeQueue,
  deferQueue,
  failQueue,
  getExtraction,
  getQueueImages,
  retryQueue,
  saveExtraction,
  updateQueueStage,
} from './queueStorage.js';
import { LlmBudgetExhaustedError } from './llmBudget.js';
import { analyzeImages, parseListingWithLlm } from './listingLlmParser.js';
import { finalizeLive, GeocodeDeferredError } from './listingFinalizer.js';
import { validateListing } from './listingSchema.js';
import { heartbeatWorker, recordWorkerLoopRestart, registerWorker, superviseWorkerItem } from './workerSupervisor.js';

const WORKER_NAME = 'parser';

export function startParserWorker() {
  if (process.env.FREDY_PARSER_ENABLED === '0') {
    logger.info('Continuous parser worker is disabled.');
    return null;
  }
  if (process.env.FREDY_LLM_ENABLED === '0') {
    logger.warn('FREDY_LLM_ENABLED=0: parsing requires the LLM; the parser worker stays disabled.');
    return null;
  }
  registerWorker(WORKER_NAME, { maxOperationMs: parserItemTimeoutMs() });
  void superviseLoop();
  logger.info('Continuous parser worker started.');
  return WORKER_NAME;
}

async function runLoop() {
  const idleMs = positiveEnv('FREDY_PARSER_IDLE_POLL_MS', 1000);
  while (true) {
    heartbeatWorker(WORKER_NAME);
    let queue = null;
    try {
      queue = claimNext();
      if (!queue) {
        await delay(idleMs);
        continue;
      }
      await superviseWorkerItem(WORKER_NAME, queue.id, (signal) => processQueueItem(queue, { signal }), {
        timeoutMs: parserItemTimeoutMs(),
      });
    } catch (error) {
      try {
        if (queue) {
          logger.error(`Unexpected parser failure for queue item '${queue.id}'`, error);
          const nextAttempt = Number(queue.attempt_count || 0) + 1;
          if (nextAttempt >= positiveEnv('FREDY_PARSER_MAX_ITEM_FAILURES', 8)) {
            failQueue(queue.id, error, {
              stage: 'parse',
              classification: { kind: 'worker_failure', attempts: nextAttempt },
            });
          } else {
            retryQueue(queue.id, error, { delayMs: retryDelay(queue.attempt_count) });
          }
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

async function superviseLoop() {
  const restartDelayMs = positiveEnv('FREDY_WORKER_RESTART_DELAY_MS', 5000);
  while (true) {
    try {
      await runLoop();
    } catch (error) {
      recordWorkerLoopRestart(WORKER_NAME, error);
      logger.error('Parser worker loop stopped unexpectedly; restarting.', error);
      await delay(restartDelayMs);
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
    if (!finalListing && visionEnabled() && !extraction?.vision_model) {
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
    } else if (!finalListing && !visionEnabled() && !extraction?.vision_model) {
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
      updateQueueStage(
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
      deferQueue(queue.id, error.message, error.retryAtMs);
      return { status: 'deferred', error };
    }
    const outcome = retryQueue(queue.id, error, {
      delayMs: retryDelay(queue.llm_attempt_count),
      llm: true,
      maxFailures: positiveEnv('FREDY_LLM_MAX_LISTING_FAILURES', 5),
      classification: { kind: 'llm_failure' },
    });
    if (outcome?.status === 'dead') {
      logger.error(`Aborted parser queue item '${queue.id}' after repeated LLM failures.`, error);
      return { status: 'dead', error };
    }
    return { status: 'retry', error };
  }

  try {
    signal?.throwIfAborted();
    updateQueueStage(queue.id, 'finalize');
    const allowMissingCoordinates = queue.geocode_attempt_count >= 4;
    const result = await finalizeLive(queue, finalListing, { allowMissingCoordinates, signal });
    signal?.throwIfAborted();
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

// Matches the detail worker's ceiling: an hour of backoff is the point past
// which a re-parse is answering a question nobody is waiting on any more.
function retryDelay(attempt) {
  const base = Math.min(60 * 60 * 1000, 60_000 * 2 ** Math.min(Math.max(attempt, 0), 6));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function visionEnabled() {
  return process.env.FREDY_LLM_VISION_ENABLED === '1';
}

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parserItemTimeoutMs() {
  // A valid item may need an initial text call plus one schema/evidence
  // correction call. Each request has its own 120-second deadline, so the
  // worker envelope must comfortably contain both and finalization.
  return positiveEnv('FREDY_PARSER_ITEM_TIMEOUT_MS', 300_000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
