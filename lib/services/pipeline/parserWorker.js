/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import { parseListingAttrs } from '../scoring/listingAttrs.js';
import {
  claimNext,
  completeQueue,
  getExtraction,
  getQueueImages,
  markQueueDead,
  retryQueue,
  saveExtraction,
  updateQueueImage,
  updateQueueStage,
} from './queueStorage.js';
import { analyzeImages, parseListingWithLlm } from './listingLlmParser.js';
import { finalizeBackfill, finalizeLive, GeocodeDeferredError } from './listingFinalizer.js';
import { downloadAndOptimizeImage } from './imageOptimizer.js';

let stopped = false;

export function startParserWorker() {
  if (process.env.FREDY_PARSER_ENABLED === '0') {
    logger.info('Continuous parser worker is disabled.');
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
    const queue = claimNext();
    if (!queue) {
      await delay(idleMs);
      continue;
    }
    try {
      await processQueueItem(queue);
    } catch (error) {
      logger.error(`Unexpected parser failure for queue item '${queue.id}'`, error);
      if (queue.attempt_count >= 5) markQueueDead(queue.id, error);
      else retryQueue(queue.id, error, { delayMs: retryDelay(queue.attempt_count) });
    }
  }
}

export async function processQueueItem(queue) {
  if (queue.queue_kind === 'backfill') await prepareBackfillImage(queue.id);
  let extraction = getExtraction(queue.id);
  let deterministic = extraction?.deterministic_json;
  if (!deterministic) {
    const discovery = queue.capture.discoveryData || {};
    const source = {
      ...discovery,
      provider: queue.provider,
      description: queue.capture.fullText || discovery.description || '',
    };
    deterministic = { source, attributes: parseListingAttrs(source) };
    saveExtraction(queue.id, {
      source_text: queue.capture.fullText || '',
      deterministic_json: deterministic,
    });
  }
  updateQueueStage(queue.id, 'deterministic');

  let visual = extraction?.visual_json;
  let visionModel = extraction?.vision_model;
  let finalListing = extraction?.llm_json;
  let textModel = extraction?.text_model;
  let parserMode = extraction?.parser_mode;
  let visionDurationMs = extraction?.vision_duration_ms;
  let llmDurationMs = extraction?.llm_duration_ms;

  if (process.env.FREDY_LLM_ENABLED !== '0' && !finalListing) {
    try {
      if (!visual) {
        const vision = await analyzeImages(getQueueImages(queue.id));
        visual = vision.summaries;
        visionModel = vision.model;
        visionDurationMs = vision.durationMs;
        saveExtraction(queue.id, {
          visual_json: visual,
          vision_model: visionModel,
          vision_duration_ms: visionDurationMs,
        });
      }
      updateQueueStage(queue.id, 'vision');
      const parsed = await parseListingWithLlm({ capture: queue.capture, deterministic, visual });
      finalListing = parsed.listing;
      textModel = parsed.model;
      llmDurationMs = parsed.durationMs;
      parserMode = 'llm';
      saveExtraction(queue.id, {
        llm_json: finalListing,
        parser_mode: parserMode,
        text_model: textModel,
        llm_duration_ms: llmDurationMs,
      });
      updateQueueStage(queue.id, 'llm');
    } catch (error) {
      if (queue.llm_attempt_count < 2) {
        retryQueue(queue.id, error, {
          delayMs: error.retryAfterMs || retryDelay(queue.llm_attempt_count),
          llm: true,
        });
        return { status: 'retry', error };
      }
      logger.warn(`LLM parsing exhausted retries for '${queue.id}'; using deterministic fallback.`, error);
      finalListing = null;
      parserMode = 'deterministic_fallback';
      saveExtraction(queue.id, { parser_mode: parserMode });
    }
  } else if (!finalListing) {
    parserMode = 'deterministic_fallback';
    saveExtraction(queue.id, { parser_mode: parserMode });
  }

  try {
    updateQueueStage(queue.id, 'finalize');
    const allowMissingCoordinates = queue.geocode_attempt_count >= 4;
    const result =
      queue.queue_kind === 'backfill'
        ? await finalizeBackfill(queue, finalListing, deterministic, { allowMissingCoordinates })
        : await finalizeLive(queue, finalListing, deterministic, { allowMissingCoordinates });
    saveExtraction(queue.id, {
      source_text: queue.capture.fullText || '',
      deterministic_json: deterministic,
      visual_json: visual,
      llm_json: finalListing,
      parser_mode: parserMode,
      vision_model: visionModel,
      text_model: textModel,
      vision_duration_ms: visionDurationMs,
      llm_duration_ms: llmDurationMs,
      parsed_at: Date.now(),
    });
    completeQueue(queue.id, result.listingId, result.status);
    return result;
  } catch (error) {
    if (error instanceof GeocodeDeferredError) {
      retryQueue(queue.id, error, {
        delayMs: Math.min(2 * 60 * 60 * 1000, retryDelay(queue.geocode_attempt_count)),
        geocode: true,
      });
      return { status: 'retry', error };
    }
    throw error;
  }
}

async function prepareBackfillImage(queueId) {
  const pending = getQueueImages(queueId).filter((image) => image.download_status === 'pending');
  for (const image of pending) {
    try {
      const optimized = await downloadAndOptimizeImage({
        position: image.position,
        kind: image.kind,
        originalUrl: image.original_url,
      });
      updateQueueImage(image.id, optimized);
    } catch (error) {
      updateQueueImage(image.id, { downloadStatus: 'failed', error: String(error?.message || error) });
    }
  }
}

function retryDelay(attempt) {
  return [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 2 * 60 * 60_000][Math.min(attempt, 4)];
}

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
