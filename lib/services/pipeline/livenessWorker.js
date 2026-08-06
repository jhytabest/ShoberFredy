/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import { env } from '../../shared/env.js';
import { withBrowserSession } from '../extractor/browserSession.js';
import { currentProxyUrl, proxyMissingFor } from '../extractor/proxySettings.js';
import { botDetected } from '../extractor/utils.js';
import { markListingAlive, markListingGone } from './sourceAudit.js';
import { cancelWork, completeWork, deferWork, registerHandler, startWorker, SINGLE_ATTEMPT } from './workQueue.js';
import { ProviderChallengeError } from './providerErrors.js';
import { settleOutcome } from './workOutcome.js';
import { isProviderPaused, pausedForMs, recordProviderSignal } from '../jobs/providerHealth.js';

const WORK_KIND = 'liveness';
const WORKER_NAME = 'liveness';

const PROXY_WAIT_MS = 30 * 60 * 1000;

export function startLivenessWorker({ providers }) {
  registerHandler(WORK_KIND, {
    name: WORKER_NAME,
    enabled: () => env('FREDY_MAINTENANCE_ENABLED'),
    timeoutMs: () => env('FREDY_DETAIL_ITEM_TIMEOUT_MS'),
    maxAttempts: () => SINGLE_ATTEMPT,
    startedMessage: 'Listing liveness worker started.',
    handler: (item, { signal }) => probeListing(item, providers, signal),
    classify: classifyLivenessFailure,
  });
  return startWorker(WORK_KIND);
}

function classifyLivenessFailure(item, classified) {
  if (classified.kind !== 'inactive') return null;
  const { listingId } = toLivenessRow(item);
  markListingGone(listingId, classified.message);
  return settleOutcome('inactive', { code: 'provider_inactive', note: classified.message });
}

function toLivenessRow(item) {
  const payload = item?.payload ?? {};
  return { listingId: payload.listingId ?? item?.key, provider: payload.provider, link: payload.link };
}

async function probeListing(item, providers, signal) {
  const { listingId, provider: providerId, link } = toLivenessRow(item);
  const provider = providers.find((loaded) => loaded.metaInformation.id === providerId);
  if (!provider || typeof provider.config?.captureDetails !== 'function') {
    cancelWork(WORK_KIND, item.key, `No configured provider can check '${providerId}'`, {
      code: 'provider_removed',
    });
    return;
  }
  if (!link) {
    cancelWork(WORK_KIND, item.key, 'Listing has no URL to check', { code: 'no_evidence' });
    return;
  }

  const proxyUrl = await currentProxyUrl();
  if (proxyMissingFor(provider, proxyUrl)) {
    deferWork(
      WORK_KIND,
      item.key,
      `'${providerId}' requires a proxy and none is configured`,
      Date.now() + PROXY_WAIT_MS,
      {
        code: 'proxy_missing',
      },
    );
    return;
  }
  if (isProviderPaused(providerId)) {
    deferWork(
      WORK_KIND,
      item.key,
      `'${providerId}' is paused after repeated failures`,
      Date.now() + pausedForMs(providerId),
      {
        code: 'provider_paused',
      },
    );
    return;
  }

  const target = { link, id: listingId, discoveredAt: Date.now() };
  const needsBrowser = provider.config.getListings == null;
  signal?.throwIfAborted();
  const capture = needsBrowser
    ? await withBrowserSession(link, proxyUrl ? { proxyUrl } : {}, (browser) =>
        provider.config.captureDetails(target, browser),
      )
    : await provider.config.captureDetails(target, null);
  signal?.throwIfAborted();

  if (botDetected(capture?.fullText || '', null)) {
    throw new ProviderChallengeError('Provider returned a bot-detection challenge for a liveness probe');
  }

  if (capture?.inactiveReason) {
    markListingGone(listingId, capture.inactiveReason);
    completeWork(WORK_KIND, item.key, {
      status: 'inactive',
      code: 'provider_inactive',
      reason: capture.inactiveReason,
    });
    logger.info(`Liveness: '${listingId}' is gone (${capture.inactiveReason}).`);
    return;
  }

  markListingAlive(listingId);
  recordProviderSignal({ provider: providerId, scope: 'item', signal: 'ok' });
  completeWork(WORK_KIND, item.key, { code: 'captured' });
}
