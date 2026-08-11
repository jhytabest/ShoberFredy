/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { env } from '../../shared/env.js';
import { withBrowserSession } from '../extractor/browserSession.js';
import { currentProxyUrl, proxyMissingFor } from '../extractor/proxySettings.js';
import { botDetected } from '../extractor/utils.js';
import { downloadAndOptimizeImages } from './imageOptimizer.js';
import { prepareEvidenceCapture } from './evidenceCleaner.js';
import { captureVersionHash, enqueueCapture, toDetailRow } from './queueStorage.js';
import { cancelWork, completeWork, deferWork, registerHandler, startWorker } from './workQueue.js';
import {
  findDetailRepresentative,
  identityClaimsForDetailQueue,
  jobsForDetailQueue,
  markSourcesInactive,
  mergeDetailSources,
  recordDetailCapture,
  sourceLinksForDetailQueue,
} from './sourceAudit.js';
import { detailDedupeKeys } from '../listings/claims.js';
import { extractDeterministicDetail } from './deterministicDetail.js';
import { CardFacts } from './listingFilters.js';
import { cardEvidence, terminalVerdict } from './terminalVerdict.js';
import { ProviderChallengeError } from './providerErrors.js';
import { settleOutcome } from './workOutcome.js';
import { isProviderPaused, pausedForMs, recordProviderSignal } from '../jobs/providerHealth.js';

const WORKER_NAME = 'detail';

const PROXY_WAIT_MS = 30 * 60 * 1000;

export function startDetailFetchWorker({ providers }) {
  registerHandler('detail', {
    name: WORKER_NAME,
    enabled: () => env('FREDY_DETAIL_FETCH_ENABLED'),
    timeoutMs: () => env('FREDY_DETAIL_ITEM_TIMEOUT_MS'),
    maxAttempts: () => env('FREDY_DETAIL_MAX_FAILURES'),
    startedMessage: 'Continuous detail fetch worker started.',
    handler: (item, { signal }) => captureDetail(toDetailRow(item), providers, signal),
    classify: classifyDetailFailure,
  });
  return startWorker('detail');
}

async function captureDetail(detail, providers, signal) {
  const jobs = jobsForDetailQueue(detail.id);
  if (!jobs.length) {
    cancelWork('detail', detail.id, 'No job is interested in this advert any more', { code: 'no_interested_job' });
    return;
  }
  const job = jobs.find((candidate) => candidate.provider?.some((entry) => entry.id === detail.provider)) ?? jobs[0];
  const sourceConfig = job.provider?.find((provider) => provider.id === detail.provider);
  const provider = providers.find((loaded) => loaded.metaInformation.id === detail.provider);
  if (!sourceConfig || !provider) {
    cancelWork('detail', detail.id, 'Provider was removed from the job', { code: 'provider_removed' });
    return;
  }

  const runtimeConfig = provider.init(sourceConfig);
  const proxyUrl = await currentProxyUrl();
  const needsBrowser = runtimeConfig.getListings == null;

  if (needsBrowser && !(runtimeConfig.url || detail.source_url || detail.discovery?.link)) {
    cancelWork('detail', detail.id, 'Advert has no URL to fetch', { code: 'no_evidence' });
    return;
  }

  if (proxyMissingFor(provider, proxyUrl)) {
    deferWork(
      'detail',
      detail.id,
      `'${detail.provider}' requires a proxy and the configured proxy is unavailable`,
      Date.now() + PROXY_WAIT_MS,
      { code: 'proxy_missing', environmental: true },
    );
    return;
  }

  if (isProviderPaused(detail.provider, job.market)) {
    deferWork(
      'detail',
      detail.id,
      `'${detail.provider}' is paused after repeated failures`,
      Date.now() + pausedForMs(detail.provider, job.market),
      { code: 'provider_paused', environmental: true },
    );
    return;
  }

  const db = SqliteConnection.getConnection();
  const claims = identityClaimsForDetailQueue(detail.id);
  const evidence = { card: cardEvidence(new CardFacts(detail.discovery)) };
  if (jobs.every((candidate) => terminalVerdict(db, { claims, job: candidate, evidence }).decided)) {
    cancelWork('detail', detail.id, 'Already decided for every interested job', { code: 'already_decided' });
    return;
  }

  signal.throwIfAborted();
  if (!needsBrowser) {
    await processDetail(detail, runtimeConfig, null, signal, job.market);
    return;
  }
  await withBrowserSession(runtimeConfig.url || detail.source_url, proxyUrl ? { proxyUrl } : {}, async (browser) => {
    signal.throwIfAborted();
    await processDetail(detail, runtimeConfig, browser, signal, job.market);
  });
}

function classifyDetailFailure(item, classified) {
  if (classified.kind !== 'inactive') return null;
  const detail = toDetailRow(item);
  markSourcesInactive(detail.id, classified.message);
  logger.info(`Provider reports listing inactive: '${detail.source_url}' (${detail.provider}).`);
  return settleOutcome('inactive', { code: 'provider_inactive', note: classified.message });
}

async function processDetail(detail, providerConfig, browser, signal, market) {
  if (typeof providerConfig.captureDetails !== 'function') {
    throw new Error(`Provider '${detail.provider}' does not implement captureDetails`);
  }
  signal?.throwIfAborted();
  const target = {
    ...detail.discovery,
    link: detail.source_url || detail.discovery?.link,
    id: detail.discovery?.id ?? detail.external_id ?? detail.source_key,
    discoveredAt: detail.discovery?.discoveredAt ?? Date.now(),
  };
  let capture = await providerConfig.captureDetails(target, browser);
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
    throw new ProviderChallengeError('Provider returned a bot-detection challenge instead of listing details');
  }
  if (!capture.inactiveReason && !capture.fullText.trim()) {
    throw new Error('Detail capture contained no usable listing evidence');
  }
  const deterministic = capture.inactiveReason ? null : extractDeterministicDetail(capture);
  const images = capture.inactiveReason ? [] : await downloadAndOptimizeImages(capture.images || []);
  signal?.throwIfAborted();
  capture.images = images.map(({ position, kind, originalUrl }) => ({ position, kind, originalUrl }));
  capture.sourceLinks = sourceLinksForDetailQueue(detail.id);
  const dedupeKeys = detailDedupeKeys({ discovery: detail.discovery, deterministic, images });
  recordDetailCapture(detail, capture, dedupeKeys);

  if (capture.inactiveReason) {
    markSourcesInactive(detail.id, capture.inactiveReason);
    completeWork('detail', detail.id, {
      status: 'inactive',
      reason: capture.inactiveReason || 'Provider marks listing inactive',
      action: 'inactive',
    });
    return null;
  }
  const representative = findDetailRepresentative(detail, dedupeKeys);
  if (representative) {
    const merged = mergeDetailSources(detail.id, representative);
    if (merged.rejected) {
      cancelWork('detail', detail.id, 'Merged into an advert that was already refused', {
        code: 'merged_into_rejected',
      });
    } else {
      completeWork('detail', detail.id, {
        status: 'duplicate',
        code: 'merged_duplicate',
        patch: { captureKey: merged.parsingQueueId ?? null },
      });
    }
    // Two source rows routinely share one canonical URL and differ only by
    // source key, so logging URLs alone renders as a source merged into itself.
    // The keys are what actually differ, so they are what identifies the merge.
    logger.info(
      `Merged duplicate detail source '${detail.provider}:${detail.source_key}' into ` +
        `'${representative.provider}:${representative.source_key}' (${representative.source_url}).`,
    );
    return null;
  }

  const sourceHash = captureVersionHash(detail.provider, detail.source_key, capture);
  const captureKey = enqueueCapture({
    provider: detail.provider,
    sourceHash,
    capture,
    images,
    detailQueueId: detail.id,
    cardRejection: detail.card_rejection,
  });
  completeWork('detail', detail.id, { code: 'captured', patch: { captureKey } });
  recordProviderSignal({ provider: detail.provider, market, scope: 'item', signal: 'ok' });
  logger.info(`Queued complete detail capture for '${detail.provider}' (${detail.source_url}).`);
  return null;
}
