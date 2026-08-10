/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import * as jobStorage from '../storage/jobStorage.js';
import { duringWorkingHoursOrNotSet } from '../../utils.js';
import FredyPipelineExecutioner from '../../FredyPipelineExecutioner.js';
import { isRunning, markFinished, markRunning } from './run-state.js';
import { resetBrowserSession, withBrowserSession } from '../extractor/browserSession.js';
import { currentProxyUrl, proxyMissingFor } from '../extractor/proxySettings.js';
import { OperationDeadlineError, withOperationDeadline } from '../pipeline/operationDeadline.js';
import { classifyProviderError } from '../pipeline/providerErrors.js';
import { env } from '../../shared/env.js';
import { hashParts } from '../../shared/hash.js';
import { isProviderPaused, pausedForMs, recordProviderSignal } from './providerHealth.js';

const DISCOVERY_TIMEOUT_MS = env('FREDY_DISCOVERY_TIMEOUT_MS');
const TICK_MS = env('FREDY_SCHEDULER_TICK_MS');
const MAX_CONCURRENT_DISCOVERIES = env('FREDY_DISCOVERY_CONCURRENCY');
const MIN_PORTAL_GAP_MS = env('FREDY_DISCOVERY_MIN_PORTAL_GAP_MS');

const skippedForMissingProxy = new Set();

export function providersAwaitingProxy() {
  return [...skippedForMissingProxy].sort();
}

// One central scheduler over every (job, provider) pair, replacing the old
// single global setInterval that ran every job sequentially on one shared
// deployment-wide cadence. Cadence is a job's own; spreading and politeness
// are the scheduler's.
export function initJobExecutionService({ providers }) {
  let inFlight = 0;
  const busyProviders = new Set();
  const providerLastStartedAt = new Map();

  setInterval(() => tick(), TICK_MS);
  tick();

  function tick() {
    const now = Date.now();
    const lastRunAtByPair = jobStorage.getProviderSchedule();
    for (const job of jobStorage.getJobs()) {
      for (const prov of job.provider) {
        attemptPair(job, prov, now, lastRunAtByPair);
      }
    }
  }

  function attemptPair(job, prov, now, lastRunAtByPair) {
    const matchedProvider = providers.find((loaded) => loaded.metaInformation.id === prov.id);
    if (!matchedProvider) return;

    const intervalMs = Math.max(1, Number(job.interval) || 0) * 60 * 1000;
    // A stable per-pair offset so three 15-minute jobs land at different
    // minutes instead of all firing on the tick after a restart.
    const offsetMs = pairOffsetMs(job.id, prov.id, intervalMs);
    const lastRunAt = lastRunAtByPair.get(`${job.id}:${prov.id}`) ?? null;
    if (!isDue(lastRunAt, now, intervalMs, offsetMs)) return;

    if (!duringWorkingHoursOrNotSet(job, now)) {
      logger.debug(
        `Job '${job.name || job.id}' is outside its working hours; '${prov.id}' stays due until they reopen.`,
      );
      return;
    }

    const pairKey = `${job.id}:${prov.id}`;
    if (isRunning(pairKey)) {
      logger.warn(
        `'${prov.id}' for job '${job.name || job.id}' is still running from a previous cycle. Skipping this run.`,
      );
      return;
    }
    // One lane per portal: at most one discovery in flight per provider, plus
    // a minimum gap between consecutive hits — politer, and less bot-like.
    if (busyProviders.has(prov.id)) {
      logger.debug(`'${prov.id}' is already discovering for another job; '${job.name || job.id}' waits its turn.`);
      return;
    }
    if (now - (providerLastStartedAt.get(prov.id) || 0) < MIN_PORTAL_GAP_MS) return;
    if (inFlight >= MAX_CONCURRENT_DISCOVERIES) {
      logger.debug(`Discovery concurrency cap reached; '${job.name || job.id}':'${prov.id}' waits for a slot.`);
      return;
    }
    if (!markRunning(pairKey)) return;

    inFlight += 1;
    busyProviders.add(prov.id);
    providerLastStartedAt.set(prov.id, now);

    executeJobProvider(job, prov, matchedProvider)
      .catch((err) => logger.error(err))
      .finally(() => {
        inFlight -= 1;
        busyProviders.delete(prov.id);
        markFinished(pairKey);
        // Recorded at completion, not at start: a pair that slipped past
        // several due windows while waiting for a lane still only runs once,
        // because this is what the next tick's due-check compares against.
        const finishedAt = Date.now();
        jobStorage.markProviderRunAt(job.id, prov.id, finishedAt);
        jobStorage.updateJobLastRunAt(job.id, finishedAt);
      });
  }

  async function executeJobProvider(job, prov, matchedProvider) {
    const proxyUrl = await currentProxyUrl();
    if (proxyMissingFor(matchedProvider, proxyUrl)) {
      if (!skippedForMissingProxy.has(prov.id)) {
        skippedForMissingProxy.add(prov.id);
        logger.warn(
          `Provider '${prov.id}' only works through a proxy and the configured proxy is unavailable. ` +
            `Skipping its discovery until the proxy is reachable.`,
        );
      }
      return;
    }
    if (skippedForMissingProxy.delete(prov.id)) {
      logger.info(`Provider '${prov.id}' has a proxy again; resuming its discovery.`);
    }
    if (isProviderPaused(prov.id, job.market)) {
      logger.info(
        `Skipping '${prov.id}' for job '${job.name || job.id}': discovery is paused for another ` +
          `${Math.round(pausedForMs(prov.id, job.market) / 60000)} min.`,
      );
      return;
    }

    // A fresh config for this run alone: two jobs on this portal never see
    // each other's url, because there is no shared config for them to share.
    const runtimeConfig = matchedProvider.init(prov);
    const execute = (browser = null) => new FredyPipelineExecutioner(runtimeConfig, job, prov.id, browser).execute();
    const usesBrowser = runtimeConfig.getListings == null;
    try {
      const discovered = await withOperationDeadline(
        () => (usesBrowser ? withBrowserSession(runtimeConfig.url, proxyUrl ? { proxyUrl } : {}, execute) : execute()),
        { timeoutMs: DISCOVERY_TIMEOUT_MS, name: `discovery:${prov.id}` },
      );
      const found = Array.isArray(discovered) && discovered.length > 0;
      recordProviderSignal({
        provider: prov.id,
        market: job.market,
        scope: 'discovery',
        signal: found ? 'ok' : 'empty',
      });
    } catch (err) {
      if (usesBrowser && err instanceof OperationDeadlineError) {
        logger.warn(`Discovery for '${prov.id}' hit its deadline; resetting the shared browser session.`);
        await resetBrowserSession().catch((resetErr) => logger.warn('Browser session reset failed', resetErr));
      }
      recordProviderSignal({
        provider: prov.id,
        market: job.market,
        scope: 'discovery',
        signal: err instanceof OperationDeadlineError ? 'timeout' : classifyProviderError(err).kind,
      });
      throw err;
    }
  }
}

function pairOffsetMs(jobId, providerId, intervalMs) {
  if (!(intervalMs > 0)) return 0;
  const digest = hashParts(jobId, providerId) || '';
  const n = Number.parseInt(digest.slice(0, 8) || '0', 16) || 0;
  return n % intervalMs;
}

function windowStart(now, intervalMs, offsetMs) {
  return Math.floor((now - offsetMs) / intervalMs) * intervalMs + offsetMs;
}

// Due at most once per interval, at a fixed phase within it. Comparing only
// against the current window's boundary — never enumerating missed ones — is
// what keeps a pair that slipped past several due times running once, not N
// times, once it finally gets a lane.
function isDue(lastRunAt, now, intervalMs, offsetMs) {
  const start = windowStart(now, intervalMs, offsetMs);
  return start <= now && (lastRunAt == null || lastRunAt < start);
}
