/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import { getJob } from '../storage/jobStorage.js';
import { getSettings } from '../storage/settingsStorage.js';
import * as puppeteerExtractor from '../extractor/puppeteerExtractor.js';
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

let stopped = false;

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
  stopped = false;
  void runLoop(providers).catch((error) => logger.error('Continuous detail fetch worker stopped unexpectedly.', error));
  logger.info('Continuous detail fetch worker started.');
}

export function stopDetailFetchWorker() {
  stopped = true;
}

async function runLoop(providers) {
  const idleMs = positiveEnv('FREDY_DETAIL_FETCH_IDLE_POLL_MS', 1000);
  let browser = null;
  let browserProxy = null;

  try {
    while (!stopped) {
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
        const job = getJob(detail.job_id);
        if (!job) {
          queueStorage.cancelDetail(detail.id, 'Job no longer exists');
          continue;
        }
        const sourceConfig = job.provider?.find((provider) => provider.id === detail.provider);
        const provider = providers.find((loaded) => loaded.metaInformation.id === detail.provider);
        if (!sourceConfig || !provider) {
          queueStorage.cancelDetail(detail.id, 'Provider was removed from the job');
          continue;
        }

        provider.init({ ...sourceConfig, userId: job.userId }, []);
        const settings = await getSettings();
        const proxyUrl = typeof settings?.proxyUrl === 'string' ? settings.proxyUrl.trim() : '';
        const needsBrowser = provider.config.getListings == null;

        if (browser && (!browser.connected || browserProxy !== proxyUrl)) {
          await puppeteerExtractor.closeBrowser(browser);
          browser = null;
        }
        if (needsBrowser && !browser) {
          browser = await puppeteerExtractor.launchBrowser(
            provider.config.url || detail.source_url,
            proxyUrl ? { proxyUrl } : {},
          );
          browserProxy = proxyUrl;
        }

        await processDetail(detail, provider.config, browser);
      } catch (error) {
        queueStorage.retryDetail(detail.id, error, { delayMs: retryDelay(detail.attempt_count) });
        logger.warn(`Detail capture deferred for '${detail.source_url}' (Provider: '${detail.provider}').`, error);
      }
    }
  } finally {
    await puppeteerExtractor.closeBrowser(browser);
  }
}

async function processDetail(detail, providerConfig, browser) {
  if (typeof providerConfig.captureDetails !== 'function') {
    throw new Error(`Provider '${detail.provider}' does not implement captureDetails`);
  }
  const job = getJob(detail.job_id);
  const discoveryReasons = preLlmFilterReasons(null, detail.discovery, job);
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
  const images = capture.inactiveReason ? [] : await downloadAndOptimizeImages(capture.images || []);
  capture.images = images.map(({ position, kind, originalUrl }) => ({ position, kind, originalUrl }));
  capture.sourceLinks = sourceLinksForDetailQueue(detail.id);
  const dedupeKeys = detailDedupeKeys({ discovery: detail.discovery, capture, images });
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
  const deterministic = extractDeterministicDetail(capture, detail.discovery);
  const filterReasons = preLlmFilterReasons(capture, detail.discovery, job, deterministic);
  const areaReason = filterReasons.length ? null : await preLlmAreaReason(detail.discovery, deterministic, job);
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

function retryDelay(attempt) {
  const base = Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(Math.max(attempt, 0), 9));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
