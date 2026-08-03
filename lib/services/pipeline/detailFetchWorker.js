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
    maxAttempts: () => env('FREDY_DETAIL_MAX_FAILURES'),
    startedMessage: 'Continuous detail fetch worker started.',
    handler: (item, { signal }) => captureDetail(toDetailRow(item), providers, signal),
    classify: classifyDetailFailure,
  });
  return startWorker('detail');
}

async function captureDetail(detail, providers, signal) {
  // Several jobs may be waiting on this one fetch, so the work item cannot name
  // a job; the sources record who asked. One of them configures the provider,
  // and every one of them must already be decided before the fetch is skipped.
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
      { code: 'proxy_missing' },
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
      { code: 'provider_paused' },
    );
    return;
  }

  // The gate, before a page is fetched. Discovery normally stops a decided
  // advert being enqueued at all, so what this catches is an item that was
  // already queued when the verdict landed — and a fetch is the second most
  // expensive thing this pipeline does.
  const db = SqliteConnection.getConnection();
  const claims = identityClaimsForDetailQueue(detail.id);
  const evidence = { card: cardEvidence(new CardFacts(detail.discovery)) };
  if (jobs.every((candidate) => terminalVerdict(db, { claims, job: candidate, evidence }).decided)) {
    cancelWork('detail', detail.id, 'Already decided for every interested job', { code: 'already_decided' });
    return;
  }

  signal.throwIfAborted();
  if (!needsBrowser) {
    await processDetail(detail, provider.config, null, signal);
    return;
  }
  await withBrowserSession(provider.config.url || detail.source_url, proxyUrl ? { proxyUrl } : {}, async (browser) => {
    signal.throwIfAborted();
    await processDetail(detail, provider.config, browser, signal);
  });
}

/**
 * The one thing the shared policy cannot know: an advert a provider says is gone
 * has to be marked inactive on its sources before the item settles.
 *
 * Everything else — challenges, rate limits, timeouts, permanent failures —
 * falls through to the table in workOutcome.js, which is the point. This used to
 * be an `onError` hook that answered the whole question itself, which is how the
 * queue ended up with three different ways of abandoning an item and why the
 * `maxFailures` registered right beside it was dead configuration.
 */
function classifyDetailFailure(item, classified) {
  if (classified.kind !== 'inactive') return null;
  const detail = toDetailRow(item);
  markSourcesInactive(detail.id, classified.message);
  logger.info(`Provider reports listing inactive: '${detail.source_url}' (${detail.provider}).`);
  return settleOutcome('inactive', { code: 'provider_inactive', note: classified.message });
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
async function processDetail(detail, providerConfig, browser, signal) {
  if (typeof providerConfig.captureDetails !== 'function') {
    throw new Error(`Provider '${detail.provider}' does not implement captureDetails`);
  }
  signal?.throwIfAborted();
  // The URL comes from `source_url`, not from the discovery card.
  //
  // `captureDetails` navigates to `listing.link`, so passing the card alone made
  // the card the only place the address lived — and the card is bulk evidence:
  // stripped from the payload when an item goes terminal, and absent entirely
  // from any item enqueued by something other than discovery. Two features
  // learned this the hard way, both navigating to `undefined`. `source_url` is
  // the canonical address, it is on every detail item, and it is what identifies
  // the advert everywhere else.
  // `id` and `discoveredAt` are supplied for the same reason: every provider
  // derives the advert's external id and capture timestamp from the card, so an
  // item enqueued without one would otherwise fall back to guessing them out of
  // the URL. The work item knows both.
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
  // The temporary deterministic dedupe is deliberately conservative. A
  // duplicate is merged into its representative source instead of discarded,
  // retaining every card, detail capture, and source URL.
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
    logger.info(`Merged duplicate detail source '${detail.source_url}' into '${representative.source_url}'.`);
    return null;
  }

  const sourceHash = captureVersionHash(detail.provider, detail.source_key, capture);
  // Nothing is filtered here. Geography is settled once, after extraction, from
  // the address the model read — see `canonicalFilterReasons`. The stage that
  // used to guess at it from a scraped address is gone.
  const captureKey = enqueueCapture({
    provider: detail.provider,
    sourceHash,
    capture,
    images,
    detailQueueId: detail.id,
  });
  completeWork('detail', detail.id, { code: 'captured', patch: { captureKey } });
  // A successful capture is evidence the provider is answering, and it was never
  // reported: success came only from discovery, so a provider serving detail
  // pages perfectly could still climb toward a six-hour pause.
  recordProviderSignal({ provider: detail.provider, scope: 'item', signal: 'ok' });
  logger.info(`Queued complete detail capture for '${detail.provider}' (${detail.source_url}).`);
  return null;
}
