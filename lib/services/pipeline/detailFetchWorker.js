/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import { getJob } from '../storage/jobStorage.js';
import { getSettings } from '../storage/settingsStorage.js';
import { withBrowserSession } from '../extractor/browserSession.js';
import { botDetected } from '../extractor/utils.js';
import { downloadAndOptimizeImages } from './imageOptimizer.js';
import { prepareEvidenceCapture } from './evidenceCleaner.js';
import * as queueStorage from './queueStorage.js';
import {
  findDetailRepresentative,
  markPreLlmHidden,
  markSourcesInactive,
  mergeDetailSources,
  recordDetailCapture,
  sourceLinksForDetailQueue,
} from './sourceAudit.js';
import { detailDedupeKeys } from './temporaryDeterministic.js';
import { extractDeterministicDetail } from './deterministicDetail.js';
import { preLlmFilterReasons, preLlmAreaReason, primaryFilterReason } from './listingFilters.js';
import { classifyProviderError, providerErrorPayload } from './providerErrors.js';
import { heartbeatWorker, recordWorkerLoopRestart, registerWorker, superviseWorkerItem } from './workerSupervisor.js';

const WORKER_NAME = 'detail';

/**
 * Continuously drain durable discovery cards independently of the discovery
 * schedule. One worker/browser is deliberate: predictable load and FIFO
 * progress are more valuable than burst throughput on the homeserver.
 */
export function startDetailFetchWorker({ providers }) {
  if (process.env.FREDY_DETAIL_FETCH_ENABLED === '0') {
    logger.info('Detail fetch worker is disabled.');
    return;
  }
  registerWorker(WORKER_NAME, { maxOperationMs: detailItemTimeoutMs() });
  void superviseLoop(providers);
  logger.info('Continuous detail fetch worker started.');
}

async function runLoop(providers) {
  const idleMs = positiveEnv('FREDY_DETAIL_FETCH_IDLE_POLL_MS', 1000);
  while (true) {
    heartbeatWorker(WORKER_NAME);
    let detail;
    try {
      detail = queueStorage.claimNextDetail();
    } catch (error) {
      logger.error('Detail queue claim failed; retrying.', error);
      await delay(idleMs);
      continue;
    }
    if (!detail) {
      await delay(idleMs);
      continue;
    }

    try {
      await superviseWorkerItem(
        WORKER_NAME,
        detail.id,
        async (signal) => {
          const job = getJob(detail.job_id);
          if (!job) {
            queueStorage.cancelDetail(detail.id, 'Job no longer exists');
            return;
          }
          const sourceConfig = job.provider?.find((provider) => provider.id === detail.provider);
          const provider = providers.find((loaded) => loaded.metaInformation.id === detail.provider);
          if (!sourceConfig || !provider) {
            queueStorage.cancelDetail(detail.id, 'Provider was removed from the job');
            return;
          }

          provider.init({ ...sourceConfig, userId: job.userId }, []);
          const settings = await getSettings();
          const proxyUrl = typeof settings?.proxyUrl === 'string' ? settings.proxyUrl.trim() : '';
          const needsBrowser = provider.config.getListings == null;

          signal.throwIfAborted();
          if (needsBrowser) {
            await withBrowserSession(
              provider.config.url || detail.source_url,
              proxyUrl ? { proxyUrl } : {},
              async (browser) => {
                signal.throwIfAborted();
                await processDetail(detail, provider.config, browser, signal);
              },
            );
          } else {
            await processDetail(detail, provider.config, null, signal);
          }
        },
        { timeoutMs: detailItemTimeoutMs() },
      );
    } catch (error) {
      const classified = classifyProviderError(error);
      const classification = providerErrorPayload(classified);
      if (classified.kind === 'inactive') {
        markSourcesInactive(detail.id, classified.message);
        queueStorage.markDetailInactive(detail.id, classified.message, null);
        logger.info(`Provider reports listing inactive: '${detail.source_url}' (${detail.provider}).`);
        continue;
      }
      const nextAttempt = Number(detail.attempt_count || 0) + 1;
      if (!classified.retryable || nextAttempt >= positiveEnv('FREDY_DETAIL_MAX_FAILURES', 8)) {
        queueStorage.cancelDetail(detail.id, classified.message, { action: 'failed', classification });
        logger.error(
          `Aborted detail queue item '${detail.id}' after ${nextAttempt} failure(s) (${classification.kind}).`,
          classified,
        );
        continue;
      }
      queueStorage.retryDetail(detail.id, classified, {
        delayMs: classified.retryAfterMs || retryDelay(detail.attempt_count),
        classification,
      });
      logger.warn(
        `Detail capture deferred for '${detail.source_url}' (Provider: '${detail.provider}', kind: '${classification.kind}').`,
        classified,
      );
    }
  }
}

async function superviseLoop(providers) {
  const restartDelayMs = positiveEnv('FREDY_WORKER_RESTART_DELAY_MS', 5000);
  while (true) {
    try {
      await runLoop(providers);
    } catch (error) {
      recordWorkerLoopRestart(WORKER_NAME, error);
      logger.error('Detail worker loop stopped unexpectedly; restarting.', error);
      await delay(restartDelayMs);
    }
  }
}

async function processDetail(detail, providerConfig, browser, signal) {
  if (typeof providerConfig.captureDetails !== 'function') {
    throw new Error(`Provider '${detail.provider}' does not implement captureDetails`);
  }
  signal?.throwIfAborted();
  const job = getJob(detail.job_id);
  const discoveryReasons = preLlmFilterReasons(detail.discovery, job);
  if (discoveryReasons.length) {
    const reason = primaryFilterReason(discoveryReasons);
    const sourceHash = queueStorage.captureVersionHash(detail.provider, detail.source_key, {
      sourceUrl: detail.source_url,
      fullText: '',
      embeddedData: [],
    });
    const listingId = markPreLlmHidden(detail, sourceHash, { fullText: '', images: [] }, reason, discoveryReasons);
    logger.info(`Soft-deleted discovery filter match '${detail.source_url}' as listing '${listingId}'.`);
    return;
  }
  let capture = await providerConfig.captureDetails(detail.discovery, browser);
  signal?.throwIfAborted();
  capture = prepareEvidenceCapture(
    {
      ...capture,
      provider: detail.provider,
      externalId: detail.external_id ?? detail.source_key,
      sourceUrl: detail.source_url,
      discoveredAt: detail.discovery.discoveredAt ?? detail.created_at,
      discoveryData: detail.discovery,
      sourceIdentity: { provider: detail.provider, sourceKey: detail.source_key },
    },
    detail.provider,
  );
  if (botDetected(capture.rawText || capture.fullText, null)) {
    throw new Error('Provider returned a bot-detection challenge instead of listing details');
  }
  if (!capture.inactiveReason && !capture.fullText.trim()) {
    throw new Error('Detail capture contained no usable listing evidence');
  }
  // Establish the trusted identity facts before detail dedupe. This keeps the
  // dedupe decision downstream of evidence extraction while the values remain
  // strictly non-canonical and are never copied into the final listing.
  const deterministic = capture.inactiveReason ? null : extractDeterministicDetail(capture, detail.discovery);
  const images = capture.inactiveReason ? [] : await downloadAndOptimizeImages(capture.images || []);
  signal?.throwIfAborted();
  capture.images = images.map(({ position, kind, originalUrl }) => ({ position, kind, originalUrl }));
  capture.sourceLinks = sourceLinksForDetailQueue(detail.id);
  const dedupeKeys = detailDedupeKeys({ discovery: detail.discovery, deterministic, images });
  recordDetailCapture(detail, capture, dedupeKeys);

  if (capture.inactiveReason) {
    markSourcesInactive(detail.id, capture.inactiveReason);
    queueStorage.markDetailInactive(detail.id, capture.inactiveReason, capture);
    return;
  }
  // The temporary deterministic dedupe is deliberately conservative. A
  // duplicate is merged into its representative source instead of discarded,
  // retaining every card, detail capture, and source URL.
  const representative = findDetailRepresentative(detail, dedupeKeys);
  if (representative) {
    const merged = mergeDetailSources(detail.id, representative);
    if (merged.hiddenReason && merged.listingId) {
      queueStorage.cancelDetail(detail.id, merged.hiddenReason);
    } else {
      queueStorage.completeDetail(detail.id, merged.parsingQueueId ?? null, capture);
    }
    logger.info(`Merged duplicate detail source '${detail.source_url}' into '${representative.source_url}'.`);
    return;
  }

  const sourceHash = queueStorage.captureVersionHash(detail.provider, detail.source_key, capture);
  // Tier-2 deterministic facts mined from the detail evidence let the blacklist,
  // specification and (async) area filters reject a listing before we spend an
  // LLM call. Deterministic values gate only; they never become canonical.
  const filterReasons = preLlmFilterReasons(detail.discovery, job, deterministic);
  const areaReason = filterReasons.length ? null : await preLlmAreaReason(detail.discovery, deterministic, job);
  signal?.throwIfAborted();
  const allReasons = areaReason ? [...filterReasons, areaReason] : filterReasons;
  if (allReasons.length) {
    const hiddenReason = primaryFilterReason(allReasons);
    const listingId = markPreLlmHidden(detail, sourceHash, capture, hiddenReason, allReasons);
    logger.info(`Soft-deleted pre-LLM filter match '${detail.source_url}' as listing '${listingId}'.`);
    return;
  }

  const queueId = queueStorage.enqueueCapture({
    jobId: detail.job_id,
    provider: detail.provider,
    sourceHash,
    capture,
    images,
    detailQueueId: detail.id,
  });
  queueStorage.completeDetail(detail.id, queueId, capture);
  logger.info(`Queued complete detail capture for '${detail.provider}' (${detail.source_url}).`);
}

// A listing that is still unreachable an hour later is almost never worth a
// six-hour wait as well: rentals go off the market faster than that, so the
// late attempt lands on a dead page. Capping the backoff keeps the tail of a
// retry chain inside the window where the answer still matters.
function retryDelay(attempt) {
  const base = Math.min(60 * 60 * 1000, 60_000 * 2 ** Math.min(Math.max(attempt, 0), 6));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function detailItemTimeoutMs() {
  return positiveEnv('FREDY_DETAIL_ITEM_TIMEOUT_MS', 300_000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
