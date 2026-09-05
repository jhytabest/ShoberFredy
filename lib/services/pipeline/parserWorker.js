/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import { env } from '../../shared/env.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { completeParse, getExtraction, saveExtraction, toParseRow, updateParseStage } from './queueStorage.js';
import { cancelWork, deferWork, registerHandler, retryWork, startWorker } from './workQueue.js';
import { identityClaimsForParsingQueue, jobsForParsingQueue, reusableExtraction } from './sourceAudit.js';
import { CardFacts } from './listingFilters.js';
import { parkOutcome } from './workOutcome.js';
import { cardEvidence, terminalVerdict } from './terminalVerdict.js';
import { canSpend, LlmBudgetExhaustedError } from './llmBudget.js';
import { sha256 } from '../../shared/hash.js';
import { buildEvidence, isCurrentExtraction, parseListingWithLlm, PROMPT_VERSION } from './listingLlmParser.js';
import { EXTRACTION_VERSION } from './listingSchema.js';
import { finalizeLive, GeocodeDeferredError } from './listingFinalizer.js';
import { extractionEnvelope } from '../listings/standardizedFacts.js';

const WORKER_NAME = 'parser';

export function startParserWorker() {
  registerHandler('parse', {
    name: WORKER_NAME,
    order: 'newest',
    enabled: parsingEnabled,
    timeoutMs: () => env('FREDY_PARSER_ITEM_TIMEOUT_MS'),
    maxAttempts: () => env('FREDY_PARSER_MAX_ITEM_FAILURES'),
    classify: (item, classified, error) => {
      if (error instanceof LlmBudgetExhaustedError) {
        return parkOutcome('llm_budget', error.message, error.retryAtMs ?? Date.now() + 60_000);
      }
      if (error instanceof GeocodeDeferredError) {
        return parkOutcome('geocode_unavailable', error.message, Date.now() + 60_000, { counter: 'geocodeAttempts' });
      }
      return null;
    },
    startedMessage: 'Continuous parser worker started.',
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

async function processQueueItem(queue, { signal } = {}) {
  const audit = {
    queueId: queue.id,
    listingId: queue.listing_id ?? null,
    provider: queue.provider,
  };
  const extraction = getExtraction(queue.id);

  let finalListing = extractionEnvelope(extraction?.llm_json);
  if (finalListing && !isCurrentExtraction(finalListing)) finalListing = null;
  if (extraction?.llm_json && !finalListing) {
    saveExtraction(queue.id, { llm_json: null, parsed_at: null });
  }

  if (!finalListing) {
    const db = SqliteConnection.getConnection();
    const claims = identityClaimsForParsingQueue(queue.id);
    const jobs = jobsForParsingQueue(queue.id);
    const evidence = {
      card: cardEvidence(new CardFacts(queue.capture?.discoveryData)),
    };
    const decisions = jobs.map((job) => terminalVerdict(db, { claims, job, evidence }));
    if (jobs.length && decisions.every((decision) => decision.decided)) {
      cancelWork('parse', queue.id, decisions[0].reason, { code: 'already_decided' });
      return { status: 'cancelled', listingId: decisions[0].listingId ?? null };
    }

    const reused = reusableExtraction(db, queue.id, claims, sha256(buildEvidence(queue.capture)), {
      schemaVersion: EXTRACTION_VERSION,
      promptVersion: PROMPT_VERSION,
    });
    const reusedListing = reused && extractionEnvelope(reused.llm_json);
    if (reusedListing && isCurrentExtraction(reusedListing)) {
      finalListing = reusedListing;
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
      deferWork('parse', queue.id, error.message, error.retryAtMs, { code: 'llm_budget' });
      return { status: 'deferred', error };
    }
    const outcome = retryWork('parse', queue.id, error, {
      counter: 'llmAttempts',
      maxFailures: env('FREDY_LLM_MAX_LISTING_FAILURES'),
      stage: 'llm',
      code: 'llm_unextractable',
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
      const untilMs = Date.now() + Math.min(2 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(queue.geocode_attempt_count, 6));
      deferWork('parse', queue.id, error.message, untilMs, {
        counter: 'geocodeAttempts',
        code: 'geocode_unavailable',
      });
      return { status: 'deferred', error };
    }
    throw error;
  }
}
