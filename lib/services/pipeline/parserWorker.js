/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import { env } from '../../shared/env.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { completeParse, getExtraction, saveExtraction, toParseRow, updateParseStage } from './queueStorage.js';
import { cancelWork, deferWork, registerHandler, retryWork, startWorker } from './workQueue.js';
import {
  identityClaimsForParsingQueue,
  jobsForParsingQueue,
  recordSourceRejection,
  reusableExtraction,
} from './sourceAudit.js';
import { filterConfigHash, terminalVerdict } from './terminalVerdict.js';
import { canSpend, LlmBudgetExhaustedError } from './llmBudget.js';
import { parseListingWithLlm } from './listingLlmParser.js';
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
 * Process one claimed queue item: one required LLM request, then finalize.
 * Rate-limit and geocode interruptions defer the item without any failure
 * accounting — the queue waits for the budget, it never bypasses it and never
 * falls back.
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
  // First, and deliberately not dedupe: this is retry idempotence, keyed on the
  // work item. Finalization can fail after a successful call — a geocoding
  // outage defers the item for up to two hours — and without this every such
  // deferral would buy the same answer again.
  const extraction = getExtraction(queue.id);

  let finalListing = extraction?.llm_json;
  if (finalListing && !validateListing(finalListing).valid) {
    finalListing = null;
    saveExtraction(queue.id, { llm_json: null, parsed_at: null });
  }

  if (!finalListing) {
    // Nothing has been bought yet, so this is the last and most valuable place
    // to ask whether the answer is already known. It is the call this gate
    // exists for: 2,704 of the 3,994 calls ever spent on rejected listings were
    // re-derivations of a verdict already recorded.
    const db = SqliteConnection.getConnection();
    const claims = identityClaimsForParsingQueue(queue.id);
    const jobs = jobsForParsingQueue(queue.id);
    for (const job of jobs) {
      const decided = terminalVerdict(db, { claims, job, tier: 'llm' });
      if (!decided.decided) continue;
      // Every interested job must agree before the call is skipped: one job's
      // polygon says nothing about another's.
      if (jobs.every((other) => terminalVerdict(db, { claims, job: other, tier: 'llm' }).decided)) {
        cancelWork('parse', queue.id, decided.reason);
        return { status: 'cancelled', listingId: decided.listingId ?? null };
      }
      break;
    }

    // A sibling capture of the same advert may already hold the answer. Copying
    // it under this item's own key keeps retry idempotence, audit attribution
    // and completion working exactly as they do for a call we paid for.
    const reused = reusableExtraction(db, queue.id, claims);
    if (reused) {
      finalListing = reused.llm_json;
      saveExtraction(queue.id, {
        llm_json: finalListing,
        text_model: reused.text_model,
        llm_duration_ms: 0,
      });
      updateParseStage(queue.id, 'llm', {
        action: 'extraction_reused',
        reason: 'An identical advert had already been extracted',
        payload: { from: reused.queue_id },
      });
    }
  }

  try {
    // One request for every item that reaches here.
    if (!finalListing) {
      const parsed = await parseListingWithLlm({ capture: queue.capture, audit, signal });
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
      // Abandoning the item alone is not enough: with no listing and no verdict,
      // nothing recognises the advert, so the next capture whose page text
      // differs at all mints a new key and buys the same failure again. Record
      // the refusal against the source so the gate can answer for it.
      const jobs = jobsForParsingQueue(queue.id);
      if (jobs.length) {
        recordSourceRejection(
          { id: queue.id, provider: queue.provider, source_key: queue.source_key, source_url: queue.source_url },
          {
            reason: 'llm_unextractable',
            stage: 'detail',
            tier: 'geo',
            configHash: filterConfigHash(jobs[0]),
            evidenceHash: null,
            captureHash: queue.source_hash,
            reasons: [{ code: 'llm_unextractable', stage: 'extraction' }],
            queue: 'parse',
          },
        );
      }
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
