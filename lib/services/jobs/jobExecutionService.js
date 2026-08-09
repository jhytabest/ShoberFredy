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

const DISCOVERY_TIMEOUT_MS = env('FREDY_DISCOVERY_TIMEOUT_MS');
// Cadence itself lives on each job now, not on one deployment-wide setting.
// This tick just has to be short enough that a job's own interval — checked
// against its own last_run_at — is noticed promptly.
const TICK_MS = 30 * 1000;

const skippedForMissingProxy = new Set();

export function providersAwaitingProxy() {
  return [...skippedForMissingProxy].sort();
}

export function initJobExecutionService({ providers }) {
  setInterval(() => tick(), TICK_MS);
  tick();

  async function tick() {
    const now = Date.now();
    for (const job of jobStorage.getJobs()) {
      if (!isDue(job, now)) continue;
      if (!duringWorkingHoursOrNotSet(job, now)) {
        logger.debug(`Job '${job.name || job.id}' is outside its working hours; skipping this tick.`);
        continue;
      }
      await executeJob(job);
    }
  }

  function isDue(job, now) {
    const intervalMs = Math.max(1, Number(job.interval) || 0) * 60 * 1000;
    const lastRunAt = Number(job.lastRunAt) || 0;
    return now >= lastRunAt + intervalMs;
  }

  async function executeJob(job) {
    if (isRunning(job.id)) {
      logger.warn(`Job '${job.name || job.id}' is still running from a previous cycle. Skipping this run.`);
      return;
    }
    const acquired = markRunning(job.id);
    if (!acquired) return;
    try {
      jobStorage.updateJobLastRunAt(job.id, Date.now());
    } catch (err) {
      logger.warn('Failed to persist last_run_at for job', job.id, err);
    }
    try {
      const proxyUrl = await currentProxyUrl();

      const jobProviders = job.provider.filter(
        (p) => providers.find((loaded) => loaded.metaInformation.id === p.id) != null,
      );
      for (const prov of jobProviders) {
        const matchedProvider = providers.find((loaded) => loaded.metaInformation.id === prov.id);
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
          matchedProvider.init(prov, []);

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
            const found = Array.isArray(discovered) && discovered.length > 0;
            recordProviderSignal({ provider: prov.id, scope: 'discovery', signal: found ? 'ok' : 'empty' });
          } catch (err) {
            if (usesBrowser && err instanceof OperationDeadlineError) {
              logger.warn(`Discovery for '${prov.id}' hit its deadline; resetting the shared browser session.`);
              await resetBrowserSession().catch((resetErr) => logger.warn('Browser session reset failed', resetErr));
            }
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
