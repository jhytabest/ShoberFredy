/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import { bus } from '../events/event-bus.js';
import * as jobStorage from '../storage/jobStorage.js';
import { duringWorkingHoursOrNotSet } from '../../utils.js';
import FredyPipelineExecutioner from '../../FredyPipelineExecutioner.js';
import { isRunning, markFinished, markRunning } from './run-state.js';
import { sendToUser } from '../sse/sse-broker.js';
import { resetBrowserSession, withBrowserSession } from '../extractor/browserSession.js';
import { getSettings } from '../storage/settingsStorage.js';
import { OperationDeadlineError, withOperationDeadline } from '../pipeline/operationDeadline.js';

// Discovery had no upper bound: a browser call that never returned left the job
// marked running forever, so every later scheduled tick skipped every job and
// discovery stopped until the container was restarted. Three jobs times four
// providers finish well inside a minute each in practice.
const DISCOVERY_TIMEOUT_MS = positiveEnv('FREDY_DISCOVERY_TIMEOUT_MS', 5 * 60 * 1000);

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Initializes the job execution service.
 * - Registers event-bus listeners for `jobs:runAll`, `jobs:runOne`, and `jobs:status`.
 * - Starts the periodic scheduler (if `intervalMs` > 0) and performs an initial run respecting working hours.
 * - Forwards job status updates to affected users via Server-Sent Events (SSE).
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
  // Forward job status to the single account.
  bus.on('jobs:status', ({ jobId, running }) => {
    try {
      const job = jobStorage.getJob(jobId);
      if (job?.userId) sendToUser(job.userId, 'jobStatus', { jobId, running });
    } catch (err) {
      logger.warn('Failed to forward job status', jobId, err);
    }
  });

  bus.on('jobs:runAll', () => {
    logger.debug('Running all jobs manually');
    runAll(false);
  });

  // Listen for single job run requests
  bus.on('jobs:runOne', ({ jobId }) => {
    logger.debug(`Running single job manually: ${jobId}`);
    // fire and forget, do not block the bus
    runSingle(jobId);
  });

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
   * Execute a single job by id.
   * Manual runs are allowed even if the job is disabled, but never duplicated when already running.
   *
   * @param {string} jobId
   * @returns {Promise<void>}
   */
  async function runSingle(jobId) {
    const job = jobStorage.getJob(jobId);
    if (!job) return;
    // allow manual run even if disabled; keep guard to avoid duplicates
    await executeJob(job);
  }

  /**
   * Executes one job across all of its configured providers.
   * Emits SSE start/finish events via the bus and ensures the run-state guard is always cleared.
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
    // notify listeners (SSE) that the job started
    try {
      bus.emit('jobs:status', { jobId: job.id, running: true });
    } catch (err) {
      logger.warn('Failed to emit start status for job', job.id, err);
    }
    try {
      // Read the proxy live (not from the startup snapshot) so changing it in the
      // UI takes effect on the next run without a backend restart. An empty value
      // disables the proxy. Routing the headless browser through a (German
      // residential) proxy avoids datacenter-IP based bot detection on the
      // Puppeteer-based providers (immowelt, kleinanzeigen, wgGesucht).
      const liveSettings = await getSettings();
      const proxyUrl = typeof liveSettings?.proxyUrl === 'string' ? liveSettings.proxyUrl.trim() : '';

      const jobProviders = job.provider.filter(
        (p) => providers.find((loaded) => loaded.metaInformation.id === p.id) != null,
      );
      for (const prov of jobProviders) {
        try {
          const matchedProvider = providers.find((loaded) => loaded.metaInformation.id === prov.id);
          // The blacklist is visibility-only and owned by the parser worker
          // (listingFinalizer visibilityVerdict); providers get an empty list
          // so their filter functions only drop broken rows.
          matchedProvider.init({ ...prov, userId: job.userId }, []);

          const execute = (browser = null) =>
            new FredyPipelineExecutioner(matchedProvider.config, job, prov.id, browser).execute();
          const usesBrowser = matchedProvider.config.getListings == null;
          try {
            await withOperationDeadline(
              () =>
                usesBrowser
                  ? withBrowserSession(matchedProvider.config.url, proxyUrl ? { proxyUrl } : {}, execute)
                  : execute(),
              { timeoutMs: DISCOVERY_TIMEOUT_MS, name: `discovery:${prov.id}` },
            );
          } catch (err) {
            if (usesBrowser && err instanceof OperationDeadlineError) {
              // The abandoned operation still holds the browser lock; only
              // closing the session lets it settle and free the next caller.
              logger.warn(`Discovery for '${prov.id}' hit its deadline; resetting the shared browser session.`);
              await resetBrowserSession().catch((resetErr) => logger.warn('Browser session reset failed', resetErr));
            }
            throw err;
          }
        } catch (err) {
          logger.error(err);
        }
      }
    } finally {
      markFinished(job.id);
      try {
        bus.emit('jobs:status', { jobId: job.id, running: false });
      } catch (err) {
        logger.warn('Failed to emit finish status for job', job.id, err);
      }
    }
  }
}
