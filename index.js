/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'fs';
import { checkIfConfigIsAccessible, getProviders, refreshConfig } from './lib/utils.js';
import * as similarityCache from './lib/services/similarity-check/similarityCache.js';
import { runMigrations } from './lib/services/storage/migrations/migrate.js';
import { ensureDemoUserExists, ensureAdminUserExists } from './lib/services/storage/userStorage.js';
import { initTrackerCron } from './lib/services/crons/tracker-cron.js';
import logger from './lib/services/logger.js';
import { reloadEnabledFromSettings } from './lib/services/debug/debugLogStorage.js';
import { initActiveCheckerCron } from './lib/services/crons/listing-alive-cron.js';
import { initDbMaintenanceCron } from './lib/services/crons/db-maintenance-cron.js';
import { getSettings } from './lib/services/storage/settingsStorage.js';
import SqliteConnection, { computeDbPath } from './lib/services/storage/SqliteConnection.js';
import { initJobExecutionService } from './lib/services/jobs/jobExecutionService.js';
import { ensureValidBinary } from './lib/services/ensureValidBinary.js';
import { startMetricsExporter } from './lib/services/market/metricsExporter.js';
import { startMarketModelScheduler } from './lib/services/market/marketModelScheduler.js';
import { startParserWorker } from './lib/services/pipeline/parserWorker.js';
import { startNotificationDispatcher } from './lib/services/pipeline/notificationDispatcher.js';
import { startRatingWorker } from './lib/services/pipeline/ratingQueue.js';
import { markInterruptedLlmAudits } from './lib/services/pipeline/llmAuditStorage.js';
import { startDetailFetchWorker } from './lib/services/pipeline/detailFetchWorker.js';
import { reconcileTerminalPipeline } from './lib/services/pipeline/pipelineReconciler.js';

if (fs.existsSync('.env.local') && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile('.env.local');
}

// Ensure the CloakBrowser stealth Chromium binary is present and complete before
// jobs run.  ensureValidBinary() also detects and auto-heals partial extractions
// (e.g. a newer version that was downloaded but only the chrome executable was
// written) so Chrome never crashes with "Invalid file descriptor to ICU data".
logger.info('Checking CloakBrowser binary...');
await ensureValidBinary();
logger.info('CloakBrowser binary ready.');

//in the config, we store the path of the sqlite file, thus we must check if it is available
const isConfigAccessible = await checkIfConfigIsAccessible();
await SqliteConnection.init();

// Load configuration before any other startup steps
await refreshConfig();

if (!isConfigAccessible) {
  logger.error('Configuration exists, but is not accessible. Please check the file permission');
  process.exit(1);
}

// Run DB migrations once at startup and block until finished
await runMigrations();
if (process.exitCode) {
  throw new Error('Database migrations failed; refusing to start against an incomplete schema.');
}
reconcileTerminalPipeline();
const interruptedAudits = markInterruptedLlmAudits();
if (interruptedAudits)
  logger.warn(`Closed ${interruptedAudits} interrupted LLM audit call(s) from the previous process.`);

const settings = await getSettings();

// Restore the persisted on/off flag for opt-in DB log capture so it survives a
// Fredy restart. reloadEnabledFromSettings() also (un)wires the logger sink based
// on the restored flag, so the logger hot path stays cost-free when nobody enabled
// the feature.
await reloadEnabledFromSettings();

// Ensure the sqlite directory exists before loading anything else (based on config.sqlitepath)
const { dir: sqliteDir } = await computeDbPath();
if (!fs.existsSync(sqliteDir)) {
  fs.mkdirSync(sqliteDir, { recursive: true });
}

// Load provider modules once at startup
const providers = await getProviders();

similarityCache.initSimilarityCache();
similarityCache.startSimilarityCacheReloader();

//assuming interval is always in minutes
const INTERVAL = settings.interval * 60 * 1000;

// Initialize API only after migrations completed
await import('./lib/api/api.js');

if (settings.demoMode) {
  logger.info('Running in demo mode');
}

ensureAdminUserExists();
ensureDemoUserExists();
await initTrackerCron();
//do not wait for this to finish, let it run in the background
initActiveCheckerCron();
// Nightly SQLite maintenance: checkpoint the WAL and bound the retained
// audit/queue payload growth (see db-maintenance-cron.js).
initDbMaintenanceCron();
// No geocoding cron: the durable parser geocodes after capture, while the
// separate geocode/backfill CLIs remain available for maintenance.

// Market services (single-container mode): Prometheus exporter on its own
// port and the periodic market model retrain, both in-process.
// FREDY_MARKET_EXPORTER_PORT=0 / FREDY_MARKET_MODEL_INTERVAL_SECONDS=0
// disable them (e.g. when running the standalone CLI daemons instead).
try {
  const metricsServer = await startMetricsExporter();
  if (metricsServer) {
    logger.info(`Market metrics exporter listening on :${metricsServer.address().port}/metrics`);
  }
} catch (error) {
  logger.error('Failed to start market metrics exporter; continuing without it', error);
}

if (process.env.FREDY_MARKET_MODEL_INTERVAL_SECONDS !== '0') {
  try {
    await startMarketModelScheduler();
  } catch (error) {
    logger.error('Failed to initialize market model; continuing without retrains', error);
  }
}

logger.info(`Started Fredy successfully. Ui can be accessed via http://localhost:${settings.port}`);

// Independent durable consumers start before the scrape producer. Neither is
// awaited by scheduled scrape runs.
startDetailFetchWorker({ providers });
startParserWorker();
startRatingWorker();
startNotificationDispatcher();

// Initialize the scrape/capture producer (schedules and bus listeners).
initJobExecutionService({ providers, settings, intervalMs: INTERVAL });
