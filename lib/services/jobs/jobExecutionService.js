/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { reevaluateJobListings } from './jobDecisionService.js';
import * as jobStorage from '../storage/jobStorage.js';
import { duringWorkingHoursOrNotSet } from '../../utils.js';
import FredyPipelineExecutioner from '../../FredyPipelineExecutioner.js';
import { isRunning, markFinished, markRunning } from './run-state.js';
import { withBrowserSession } from '../extractor/browserSession.js';
import { heartbeatWorker, registerWorker } from '../pipeline/workerSupervisor.js';
import { currentProxyUrl, proxyMissingFor } from '../extractor/proxySettings.js';
import { OperationDeadlineError, withOperationDeadline } from '../pipeline/operationDeadline.js';
import { classifyProviderError } from '../pipeline/providerErrors.js';
import { env } from '../../shared/env.js';
import { hashParts } from '../../shared/hash.js';
import {
  recordDiscoveryRun,
  clearProviderPauses,
  isProviderPaused,
  pausedForMs,
  recordProviderSignal,
} from './providerHealth.js';

const DISCOVERY_TIMEOUT_MS = env('FREDY_DISCOVERY_TIMEOUT_MS');
const TICK_MS = env('FREDY_SCHEDULER_TICK_MS');
const MAX_CONCURRENT_DISCOVERIES = env('FREDY_DISCOVERY_CONCURRENCY');
const MIN_PORTAL_GAP_MS = env('FREDY_DISCOVERY_MIN_PORTAL_GAP_MS');

export const SCHEDULER_WORKER = 'discovery-scheduler';

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

  // The scheduler is the one loop that drives work without being a queue worker,
  // so it was the one loop whose death nothing reported. Registering it means a
  // scheduler that stops ticking shows up in the same worker_health check the
  // queue workers already feed, rather than only as an absence of listings.
  registerWorker(SCHEDULER_WORKER, { maxOperationMs: DISCOVERY_TIMEOUT_MS });

  // Whether the last tick saw a usable proxy, so a recovery can be noticed. Null
  // until the first tick establishes a baseline; a deployment with no proxy
  // configured simply stays false and never transitions.
  let proxyWasUsable = null;

  const safeTick = () => tick().catch((error) => logger.error(error));
  setInterval(safeTick, TICK_MS);
  safeTick();

  async function tick() {
    heartbeatWorker(SCHEDULER_WORKER);
    await reconcileProxyRecovery();
    const now = Date.now();
    const lastRunAtByPair = jobStorage.getProviderSchedule();
    for (const job of jobStorage.getJobs()) {
      try {
        reevaluateJobListings(SqliteConnection.getConnection(), job);
      } catch (error) {
        logger.event('job_decision_failed', 'error', `Could not evaluate stored listings for job '${job.id}'.`, error);
        continue;
      }
      for (const prov of job.provider.filter(
        (entry, index, entries) => entries.findIndex((other) => other.id === entry.id) === index,
      )) {
        attemptPair(job, prov, now, lastRunAtByPair);
      }
    }
  }

  async function reconcileProxyRecovery() {
    const usable = Boolean(await currentProxyUrl());
    if (proxyWasUsable === false && usable) {
      clearProviderPauses('the outbound proxy is reachable again');
    }
    proxyWasUsable = usable;
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
      // Backpressure, not failure: a run whose wall clock exceeds its job's
      // interval simply keeps the slot, and the next due window finds it busy.
      // At WARN this read as an outage — thousands of lines describing a
      // scheduler working as designed — so it sits with the sibling
      // lane-contention message below, at debug.
      logger.debug(
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

    executeProviderSearches(job, prov.id, matchedProvider)
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

  async function executeProviderSearches(job, providerId, matchedProvider) {
    for (const prov of job.provider.filter((entry) => entry.id === providerId)) {
      try {
        await executeJobProvider(job, prov, matchedProvider);
      } catch (error) {
        logger.error(error);
      }
    }
  }

  async function executeJobProvider(job, prov, matchedProvider) {
    const proxyUrl = await currentProxyUrl();
    if (proxyMissingFor(matchedProvider, proxyUrl)) {
      recordDiscoveryRun(job, prov, 'proxy_unavailable');
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
      recordDiscoveryRun(job, prov, 'paused');
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
    const usesBrowser = runtimeConfig.discoveryNeedsBrowser || runtimeConfig.getListings == null;
    try {
      // The signal was created and aborted before, but never handed to anyone:
      // the deadline rejected this promise while the discovery underneath it kept
      // running, holding the shared browser. Passing it down is what lets the
      // session tear the browser out and make that work actually stop.
      const discovered = await withOperationDeadline(
        (signal) =>
          usesBrowser
            ? withBrowserSession(runtimeConfig.url, { ...(proxyUrl ? { proxyUrl } : {}), signal }, execute)
            : execute(),
        { timeoutMs: DISCOVERY_TIMEOUT_MS, name: `discovery:${prov.id}` },
      );
      const found = Array.isArray(discovered) && discovered.length > 0;
      recordDiscoveryRun(job, prov, found ? 'ok' : 'empty', discovered?.length ?? 0);
      recordProviderSignal({
        provider: prov.id,
        market: job.market,
        scope: 'discovery',
        signal: found ? 'ok' : 'empty',
      });
    } catch (err) {
      recordDiscoveryRun(
        job,
        prov,
        err instanceof OperationDeadlineError ? 'timeout' : classifyProviderError(err).kind,
      );
      if (usesBrowser && err instanceof OperationDeadlineError) {
        // The session owns the teardown now: aborting it kills the browser, so
        // by the time we get here there is nothing left to reset.
        logger.warn(`Discovery for '${prov.id}' hit its deadline; the shared browser was torn down.`);
      }
      // A run that started with a proxy and ends without one failed because our
      // egress went away mid-flight, which is not evidence about the portal.
      // Scoring it opened breakers on three providers at once every time the
      // exit node dropped, and the pause then outlived the recovery.
      if (proxyUrl && !(await currentProxyUrl())) {
        logger.warn(
          `Discovery for '${prov.id}' failed after the proxy became unreachable; ` +
            `not counting it against the provider.`,
        );
        throw err;
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
