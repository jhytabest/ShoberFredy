/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import { env } from '../../shared/env.js';
import { withBrowserSession } from '../extractor/browserSession.js';
import { currentProxyUrl, proxyMissingFor } from '../extractor/proxySettings.js';
import { botDetected } from '../extractor/utils.js';
import { downloadAndOptimizeImages } from './imageOptimizer.js';
import { prepareEvidenceCapture } from './evidenceCleaner.js';
import { captureVersionHash, enqueueCapture, toDetailRow } from './queueStorage.js';
import { cancelWork, completeWork, deferWork, registerHandler, retryWork, startWorker } from './workQueue.js';
import {
  findDetailRepresentative,
  jobsForDetailQueue,
  markSourcesInactive,
  mergeDetailSources,
  recordDetailCapture,
  recordSourceRejection,
  sourceLinksForDetailQueue,
} from './sourceAudit.js';
import { detailDedupeKeys } from '../listings/claims.js';
import { extractDeterministicDetail } from './deterministicDetail.js';
import { geoRejectReason } from './listingFilters.js';
import { geoFacts } from './stageFacts.js';
import { filterConfigHash, geoEvidenceHash } from './terminalVerdict.js';
import { classifyProviderError, providerErrorPayload, ProviderChallengeError } from './providerErrors.js';
import {
  isProviderPaused,
  pausedForMs,
  recordProviderFailure as recordBreakerFailure,
} from '../jobs/providerCircuitBreaker.js';

const WORKER_NAME = 'detail';

/**
 * How long a capture waits when its provider needs a proxy that is not
 * configured. Only an operator edit changes that answer, so re-asking often
 * costs claims and gains nothing; discovery already refuses to enqueue more
 * work for such a provider, which bounds what can be waiting here.
 */
const PROXY_WAIT_MS = 30 * 60 * 1000;

/**
 * Continuously drain durable discovery cards independently of the discovery
 * schedule. One worker/browser is deliberate: predictable load and FIFO
 * progress are more valuable than burst throughput on the homeserver.
 *
 * @param {{providers: object[]}} params
 * @returns {string|null} worker name, or null when the kill switch is off
 */
export function startDetailFetchWorker({ providers }) {
  registerHandler('detail', {
    name: WORKER_NAME,
    enabled: () => env('FREDY_DETAIL_FETCH_ENABLED'),
    timeoutMs: () => env('FREDY_DETAIL_ITEM_TIMEOUT_MS'),
    maxFailures: () => env('FREDY_DETAIL_MAX_FAILURES'),
    startedMessage: 'Continuous detail fetch worker started.',
    handler: (item, { signal }) => captureDetail(toDetailRow(item), providers, signal),
    onError: recordProviderFailure,
  });
  return startWorker('detail');
}

async function captureDetail(detail, providers, signal) {
  // Several jobs may be waiting on this one fetch, so the work item cannot name
  // a job; the sources record who asked. The first is used to configure the
  // provider, and all of them get a say in the geographic check below.
  const jobs = jobsForDetailQueue(detail.id);
  if (!jobs.length) {
    cancelWork('detail', detail.id, 'No job is interested in this advert any more');
    return;
  }
  const job = jobs.find((candidate) => candidate.provider?.some((entry) => entry.id === detail.provider)) ?? jobs[0];
  const sourceConfig = job.provider?.find((provider) => provider.id === detail.provider);
  const provider = providers.find((loaded) => loaded.metaInformation.id === detail.provider);
  if (!sourceConfig || !provider) {
    cancelWork('detail', detail.id, 'Provider was removed from the job');
    return;
  }

  provider.init({ ...sourceConfig, userId: job.userId }, []);
  const proxyUrl = await currentProxyUrl();
  const needsBrowser = provider.config.getListings == null;

  // Discovery stops enqueueing for a proxy-only provider as soon as the setting
  // is cleared, so anything reaching here was queued while a proxy still
  // existed. Waiting keeps the advert; attempting it would spend the item's
  // failure budget on a bot challenge and abandon it for a config mistake.
  if (proxyMissingFor(provider, proxyUrl)) {
    deferWork(
      'detail',
      detail.id,
      `'${detail.provider}' requires a proxy and none is configured`,
      Date.now() + PROXY_WAIT_MS,
    );
    return;
  }

  // The breaker already knows this provider is refusing to answer. Walking the
  // rest of the queue into it proves nothing and costs a browser session each
  // time; the pause is the answer for queued captures as much as for discovery.
  if (isProviderPaused(detail.provider)) {
    deferWork(
      'detail',
      detail.id,
      `'${detail.provider}' is paused after repeated failures`,
      Date.now() + pausedForMs(detail.provider),
    );
    return;
  }

  signal.throwIfAborted();
  if (!needsBrowser) {
    await processDetail(detail, provider.config, null, jobs, signal);
    return;
  }
  await withBrowserSession(provider.config.url || detail.source_url, proxyUrl ? { proxyUrl } : {}, async (browser) => {
    signal.throwIfAborted();
    await processDetail(detail, provider.config, browser, jobs, signal);
  });
}

/**
 * Translate a provider failure into a queue outcome.
 *
 * The generic policy — retry with backoff until maxFailures — is wrong here in
 * two ways this has to fix: an advert the provider says is gone is not a
 * failure at all, and a permanently broken source should not consume eight
 * attempts to establish that.
 *
 * @returns {boolean} true, because every provider failure is recorded here
 */
function recordProviderFailure(item, error) {
  const detail = toDetailRow(item);
  const classified = classifyProviderError(error);
  const classification = providerErrorPayload(classified);

  if (classified.kind === 'inactive') {
    markSourcesInactive(detail.id, classified.message);
    completeWork('detail', detail.id, { status: 'inactive', reason: classified.message, action: 'inactive' });
    logger.info(`Provider reports listing inactive: '${detail.source_url}' (${detail.provider}).`);
    return true;
  }

  // A bot challenge is a statement about the provider, not about this advert.
  // Counting it as an attempt spends one listing's failure budget per blocked
  // request and abandons perfectly good adverts eight at a time, while the
  // breaker — fed only from discovery until now — stays closed and every other
  // queued item walks into the same wall. Tell the breaker instead and wait.
  if (classified.kind === 'challenge') {
    recordBreakerFailure(detail.provider, 'detail capture challenged');
    const waitMs = pausedForMs(detail.provider) || env('FREDY_PROVIDER_BREAKER_COOLDOWN_MS');
    deferWork('detail', detail.id, classified.message, Date.now() + waitMs);
    logger.warn(
      `Detail capture for '${detail.source_url}' was challenged by '${detail.provider}'; ` +
        `waiting ${Math.round(waitMs / 60000)} min without spending an attempt.`,
    );
    return true;
  }

  const nextAttempt = Number(detail.attempt_count || 0) + 1;
  if (!classified.retryable || nextAttempt >= env('FREDY_DETAIL_MAX_FAILURES')) {
    cancelWork('detail', detail.id, classified.message, { action: 'failed', classification });
    logger.error(
      `Aborted detail queue item '${detail.id}' after ${nextAttempt} failure(s) (${classification.kind}).`,
      classified,
    );
    return true;
  }

  retryWork('detail', detail.id, classified, {
    delayMs: classified.retryAfterMs || null,
    stage: 'detail',
    classification,
  });
  logger.warn(
    `Detail capture deferred for '${detail.source_url}' (Provider: '${detail.provider}', kind: '${classification.kind}').`,
    classified,
  );
  return true;
}

/**
 * Fetch the advert and decide the one thing worth deciding here.
 *
 * The card filter used to be re-run at the top of this function, in case the
 * job's configuration had changed between enqueue and capture. It is gone: the
 * queue drains in minutes, so the window it guarded is a rounding error, and it
 * produced a rejection with no detail evidence behind it at the exact point the
 * page was about to be fetched anyway.
 *
 * The deterministic blacklist and specification re-checks are gone too. Over a
 * week they rejected 215 adverts — after the fetch they were meant to save had
 * already been paid — against 855 for the geographic check beside them. What
 * they cost was not the CPU: it was an entire tier of scraped facts that had to
 * be trusted, confidence-weighted and kept from leaking into canonical values.
 */
async function processDetail(detail, providerConfig, browser, jobs, signal) {
  if (typeof providerConfig.captureDetails !== 'function') {
    throw new Error(`Provider '${detail.provider}' does not implement captureDetails`);
  }
  signal?.throwIfAborted();
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
    // Typed, so this lands in the challenge branch above rather than being
    // degraded to a generic transient error that spends the item's attempts.
    throw new ProviderChallengeError('Provider returned a bot-detection challenge instead of listing details');
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
    completeWork('detail', detail.id, {
      status: 'inactive',
      reason: capture.inactiveReason || 'Provider marks listing inactive',
      action: 'inactive',
    });
    return null;
  }
  // The temporary deterministic dedupe is deliberately conservative. A
  // duplicate is merged into its representative source instead of discarded,
  // retaining every card, detail capture, and source URL.
  const representative = findDetailRepresentative(detail, dedupeKeys);
  if (representative) {
    const merged = mergeDetailSources(detail.id, representative);
    if (merged.rejected) {
      cancelWork('detail', detail.id, 'Merged into an advert that was already refused');
    } else {
      completeWork('detail', detail.id, { patch: { captureKey: merged.parsingQueueId ?? null } });
    }
    logger.info(`Merged duplicate detail source '${detail.source_url}' into '${representative.source_url}'.`);
    return null;
  }

  const sourceHash = captureVersionHash(detail.provider, detail.source_key, capture);
  // The only pre-extraction question left, and the only one that paid for
  // itself: is this even in the right place? It rejects only when the geocode is
  // precise enough to name a building and the point is outside every interested
  // job's polygons — an advert any job wants must reach the model.
  const facts = geoFacts(deterministic, detail.discovery);
  const areaReason = await geoRejectReason(facts, jobs);
  signal?.throwIfAborted();
  if (areaReason) {
    recordSourceRejection(detail, {
      reason: areaReason.code,
      stage: 'detail',
      tier: 'geo',
      // Every interested job agreed, so any of their hashes would do; the first
      // is used, and a job whose polygons change gets a new hash and re-decides.
      configHash: filterConfigHash(jobs[0]),
      evidenceHash: geoEvidenceHash(facts),
      captureHash: sourceHash,
      facts: { title: detail.discovery?.title ?? null, address: facts.geoAddress },
      reasons: [areaReason],
    });
    logger.info(`Refused '${detail.source_url}' before extraction: outside every interested area.`);
    return null;
  }

  const captureKey = enqueueCapture({
    provider: detail.provider,
    sourceHash,
    capture,
    images,
    detailQueueId: detail.id,
  });
  completeWork('detail', detail.id, { patch: { captureKey } });
  logger.info(`Queued complete detail capture for '${detail.provider}' (${detail.source_url}).`);
  return null;
}
