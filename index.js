/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'fs';
import { checkIfConfigIsAccessible, getProviders, refreshConfig } from './lib/utils.js';
import { runMigrations } from './lib/services/storage/migrations/migrate.js';
import { ensureAdminUserExists } from './lib/services/storage/userStorage.js';
import logger from './lib/services/logger.js';
import { getSettings } from './lib/services/storage/settingsStorage.js';
import SqliteConnection, { computeDbPath } from './lib/services/storage/SqliteConnection.js';
import { initJobExecutionService } from './lib/services/jobs/jobExecutionService.js';
import { ensureValidBinary } from './lib/services/ensureValidBinary.js';
import { startMetricsExporterProcess } from './lib/services/market/metricsExporterSupervisor.js';
import { startMarketModelScheduler } from './lib/services/market/marketModelScheduler.js';
import { startParserWorker } from './lib/services/pipeline/parserWorker.js';
import { startNotificationDispatcher } from './lib/services/pipeline/notificationDispatcher.js';
import { startRatingWorker } from './lib/services/pipeline/ratingQueue.js';
import { markInterruptedLlmAudits } from './lib/services/pipeline/llmAuditStorage.js';
import { startDetailFetchWorker } from './lib/services/pipeline/detailFetchWorker.js';
import { expectWorkers } from './lib/services/pipeline/workerSupervisor.js';
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

// The config contains the SQLite directory. Create the default before opening
// the database, while still refusing to replace an unreadable existing file.
const isConfigAccessible = await checkIfConfigIsAccessible();
if (!isConfigAccessible) {
  logger.error('Configuration exists, but is not accessible. Please check the file permission');
  process.exit(1);
}
await refreshConfig();
await SqliteConnection.init();

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

// Ensure the sqlite directory exists before loading anything else (based on config.sqlitepath)
const { dir: sqliteDir } = await computeDbPath();
if (!fs.existsSync(sqliteDir)) {
  fs.mkdirSync(sqliteDir, { recursive: true });
}

// Load provider modules once at startup
const providers = await getProviders();

//assuming interval is always in minutes
const INTERVAL = settings.interval * 60 * 1000;

// Initialize API only after migrations completed
await import('./lib/api/api.js');

ensureAdminUserExists();

// Market services: the Prometheus exporter and CPU-heavy retraining run in
// child processes so observability and model work cannot block the API loop.
// Market training is the application's only cron. FREDY_MARKET_MODEL_CRON=0
// disables it; all pipeline work is durable and event/queue driven.
try {
  await startMetricsExporterProcess();
} catch (error) {
  logger.error('Failed to start market metrics exporter; continuing without it', error);
}

if (process.env.FREDY_MARKET_MODEL_CRON !== '0') {
  try {
    await startMarketModelScheduler();
  } catch (error) {
    logger.error('Failed to initialize market model; continuing without retrains', error);
  }
}

logger.info(`Started Fredy successfully. Ui can be accessed via http://localhost:${settings.port}`);

// Independent durable consumers start before the scrape producer. Neither is
// awaited by scheduled scrape runs. Each returns its name when it actually
// started, so the health endpoint can tell "disabled on purpose" apart from
// "failed to start" instead of reporting an empty worker set as healthy.
const startedWorkers = [startDetailFetchWorker({ providers }), startParserWorker(), startRatingWorker()];
expectWorkers(startedWorkers.filter(Boolean));
startNotificationDispatcher();

// Initialize the scrape/capture producer (schedules and bus listeners).
initJobExecutionService({ providers, settings, intervalMs: INTERVAL });
