/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import { getJob } from '../storage/jobStorage.js';
import { getSettings } from '../storage/settingsStorage.js';
import * as puppeteerExtractor from '../extractor/puppeteerExtractor.js';
import { downloadAndOptimizeImages } from './imageOptimizer.js';
import { prepareEvidenceCapture } from './evidenceCleaner.js';
import * as queueStorage from './queueStorage.js';

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
  if (capture.inactiveReason) {
    queueStorage.markDetailInactive(detail.id, capture.inactiveReason, capture);
    return;
  }
  if (!capture.fullText.trim()) throw new Error('Detail capture contained no usable listing evidence');

  const images = await downloadAndOptimizeImages(capture.images || []);
  capture.images = images.map(({ position, kind, originalUrl }) => ({ position, kind, originalUrl }));
  const sourceHash = queueStorage.captureVersionHash(detail.provider, detail.source_key, capture);
  const queueId = queueStorage.enqueueCapture({
    jobId: detail.job_id,
    provider: detail.provider,
    sourceHash,
    capture,
    images,
  });
  queueStorage.completeDetail(detail.id, queueId);
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
