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
import { isProviderPaused, pausedForMs, recordProviderSignal } from './providerHealth.js';

// Discovery had no upper bound: a browser call that never returned left the job
// marked running forever, so every later scheduled tick skipped every job and
// discovery stopped until the container was restarted. Three jobs times four
// providers finish well inside a minute each in practice, so the ceiling only
// has to be generous enough for a slow page — not for a hung one. It used to
// sit at five minutes, which meant a single blocked provider could stall a run
// longer than the scheduling interval itself. The two-minute default now lives
// in the env registry.
const DISCOVERY_TIMEOUT_MS = env('FREDY_DISCOVERY_TIMEOUT_MS');

/**
 * Providers currently skipped because they require a proxy and none is set.
 * Held only so the explanation is logged when the state changes: three jobs on
 * a fifteen-minute schedule would otherwise repeat it a few hundred times a day
 * and bury everything else.
 *
 * @type {Set<string>}
 */
const skippedForMissingProxy = new Set();

/**
 * Providers currently idle for want of a proxy, for the health endpoint. Idle by
 * configuration and idle by failure look identical from outside the process, and
 * only one of them is worth waking up for.
 *
 * @returns {string[]}
 */
export function providersAwaitingProxy() {
  return [...skippedForMissingProxy].sort();
}

/**
 * Initializes the job execution service.
 * - Starts the periodic scheduler (if `intervalMs` > 0) and performs an initial run respecting working hours.
 *
 * This function is intentionally side-effectful and exposes no external API.
 *
 * @param {Object} deps - Dependencies required to initialize the service.
 * @param {Array<Object>} deps.providers - Loaded provider modules. Each module must expose `metaInformation.id`, `config`, and `init(config, blacklist)`.
 * @param {Object} deps.settings - Global settings used for scheduling and provider access.
 * @param {number} deps.intervalMs - Scheduler interval in milliseconds. If not finite or <= 0, the scheduler is not started.
 * @returns {void}
 */
export function initJobExecutionService({ providers, settings, intervalMs }) {
  // Start scheduler and initial run
  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    setInterval(() => runAll(true), intervalMs);
  }
  // start once at startup, respecting working hours
  runAll(true);

  /**
   * Execute all enabled jobs, optionally filtering by context (admin/owner) and respecting working hours.
   *
   * @param {boolean} [respectWorkingHours=true] - If true, skip execution when outside configured working hours.
   * @returns {void}
   */
  async function runAll(respectWorkingHours = true) {
    const now = Date.now();
    const withinHours = duringWorkingHoursOrNotSet(settings, now);
    if (respectWorkingHours && !withinHours) {
      logger.debug('Working hours set. Skipping as outside of working hours.');
      return;
    }
    const jobs = jobStorage.getJobs();

    for (const job of jobs) {
      await executeJob(job);
    }
  }

  /**
   * Executes one job across all of its configured providers.
   * Ensures the run-state guard is always cleared.
   * Provider errors are surfaced via logging but do not abort other providers.
   *
   * @param {Object} job
   * @param {string} job.id
   * @param {Array<{id:string}>} job.provider
   * @param {Array<string>} [job.blacklist]
   * @param {*} job.notificationAdapter
   * @returns {Promise<void>}
   */
  async function executeJob(job) {
    if (isRunning(job.id)) {
      // A scheduled tick finding the previous run still in flight means the run
      // is wedged, not merely slow: the interval is far longer than a healthy
      // cycle. This was logged at debug, so a stalled scheduler looked exactly
      // like an idle one.
      logger.warn(`Job '${job.name || job.id}' is still running from a previous cycle. Skipping this run.`);
      return;
    }
    const acquired = markRunning(job.id);
    if (!acquired) return;
    // Persist the trigger time so the dashboard "last search" KPI can be
    // derived per accessible user without an in-memory cache.
    try {
      jobStorage.updateJobLastRunAt(job.id, Date.now());
    } catch (err) {
      logger.warn('Failed to persist last_run_at for job', job.id, err);
    }
    try {
      // Read the proxy live (not from the startup snapshot) so changing it in the
      // UI takes effect on the next run without a backend restart. An empty value
      // disables the proxy. Routing the headless browser through a (German
      // residential) proxy avoids datacenter-IP based bot detection on the
      // Puppeteer-based providers (immowelt, kleinanzeigen, wgGesucht).
      const proxyUrl = await currentProxyUrl();

      const jobProviders = job.provider.filter(
        (p) => providers.find((loaded) => loaded.metaInformation.id === p.id) != null,
      );
      for (const prov of jobProviders) {
        const matchedProvider = providers.find((loaded) => loaded.metaInformation.id === prov.id);
        // A provider that cannot work without a proxy is not paused and not
        // failing, it is unconfigured: skipping it leaves the breaker untouched,
        // so it starts from a clean slate the moment a proxy appears.
        if (proxyMissingFor(matchedProvider, proxyUrl)) {
          if (!skippedForMissingProxy.has(prov.id)) {
            skippedForMissingProxy.add(prov.id);
            logger.warn(
              `Provider '${prov.id}' only works through a proxy and none is configured. ` +
                `Skipping its discovery until the 'proxyUrl' setting is filled in.`,
            );
          }
          continue;
        }
        if (skippedForMissingProxy.delete(prov.id)) {
          logger.info(`Provider '${prov.id}' has a proxy again; resuming its discovery.`);
        }
        if (isProviderPaused(prov.id)) {
          logger.info(
            `Skipping '${prov.id}' for job '${job.name || job.id}': discovery is paused for another ` +
              `${Math.round(pausedForMs(prov.id) / 60000)} min.`,
          );
          continue;
        }
        try {
          // The blacklist is visibility-only and owned by the parser worker
          // (listingFinalizer visibilityVerdict); providers get an empty list
          // so their filter functions only drop broken rows.
          matchedProvider.init({ ...prov, userId: job.userId }, []);

          const execute = (browser = null) =>
            new FredyPipelineExecutioner(matchedProvider.config, job, prov.id, browser).execute();
          const usesBrowser = matchedProvider.config.getListings == null;
          try {
            const discovered = await withOperationDeadline(
              () =>
                usesBrowser
                  ? withBrowserSession(matchedProvider.config.url, proxyUrl ? { proxyUrl } : {}, execute)
                  : execute(),
              { timeoutMs: DISCOVERY_TIMEOUT_MS, name: `discovery:${prov.id}` },
            );
            // 'empty' is its own signal at reduced weight. It used to be filed
            // identically to a refusal, so "the markup changed" and "we are
            // blocked" were the same fact — and an empty search page is equally
            // consistent with nobody having listed a flat in that polygon.
            const found = Array.isArray(discovered) && discovered.length > 0;
            recordProviderSignal({ provider: prov.id, scope: 'discovery', signal: found ? 'ok' : 'empty' });
          } catch (err) {
            if (usesBrowser && err instanceof OperationDeadlineError) {
              // The abandoned operation still holds the browser lock; only
              // closing the session lets it settle and free the next caller.
              logger.warn(`Discovery for '${prov.id}' hit its deadline; resetting the shared browser session.`);
              await resetBrowserSession().catch((resetErr) => logger.warn('Browser session reset failed', resetErr));
            }
            // Discovery keeps its classification now. `throwOnFailure` carries a
            // typed error up from the extractor, so a challenge is recorded as a
            // challenge instead of collapsing into "no cards discovered".
            recordProviderSignal({
              provider: prov.id,
              scope: 'discovery',
              signal: err instanceof OperationDeadlineError ? 'timeout' : classifyProviderError(err).kind,
            });
            throw err;
          }
        } catch (err) {
          logger.error(err);
        }
      }
    } finally {
      markFinished(job.id);
    }
  }
}
