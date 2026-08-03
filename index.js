/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'fs';
import { checkIfConfigIsAccessible, getProviders, refreshConfig } from './lib/utils.js';
import { runMigrations } from './lib/services/storage/migrations/migrate.js';
import logger from './lib/services/logger.js';
import { getSettings } from './lib/services/storage/settingsStorage.js';
import SqliteConnection, { computeDbPath } from './lib/services/storage/SqliteConnection.js';
import { initJobExecutionService } from './lib/services/jobs/jobExecutionService.js';
import { ensureValidBinary } from './lib/services/ensureValidBinary.js';
import { startHealthServer } from './lib/health/healthServer.js';
import { startMetricsExporterProcess } from './lib/services/market/metricsExporterSupervisor.js';
import { startMarketModelScheduler } from './lib/services/market/marketModelScheduler.js';
import { startParserWorker } from './lib/services/pipeline/parserWorker.js';
import { startNotificationDispatcher } from './lib/services/pipeline/notificationDispatcher.js';
import { startLivenessWorker } from './lib/services/pipeline/livenessWorker.js';
import { startRatingWorker } from './lib/services/pipeline/ratingQueue.js';
import { startDetailFetchWorker } from './lib/services/pipeline/detailFetchWorker.js';
import { startMaintenanceWorker } from './lib/services/pipeline/maintenanceWorker.js';
import { expectWorkers } from './lib/services/pipeline/workerSupervisor.js';
import { env } from './lib/shared/env.js';

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
// Nothing is repaired here. Two startup passes used to run before the workers:
// one reasserted terminal filters over active detail rows, one closed LLM audit
// calls left open by the previous process. Both existed because crash recovery
// was per-queue and ad hoc. Work items now carry a lease, so anything the dead
// process was holding is reclaimed by whichever worker polls next, with the
// interrupted attempt counted — and a repair pass that has nothing to repair is
// just a slower start and one more thing to keep correct.

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

// The only HTTP surface: a liveness probe for the container and the deploy gate.
await startHealthServer(settings.port || 9998);

// Market services: the Prometheus exporter and CPU-heavy retraining run in
// child processes so observability and model work cannot block the main loop.
// The training cron only enqueues durable work; FREDY_MARKET_MODEL_CRON=0
// disables that producer.
try {
  await startMetricsExporterProcess();
} catch (error) {
  logger.error('Failed to start market metrics exporter; continuing without it', error);
}

let marketModelWorker = null;
if (env('FREDY_MARKET_MODEL_CRON') !== '0') {
  try {
    marketModelWorker = await startMarketModelScheduler();
  } catch (error) {
    logger.error('Failed to initialize market model; continuing without retrains', error);
  }
}

logger.info('Started successfully. Listings are delivered over Telegram; there is no UI.');

// Independent durable consumers start before the scrape producer. Neither is
// awaited by scheduled scrape runs. Each returns its name when it actually
// started, so the health endpoint can tell "disabled on purpose" apart from
// "failed to start" instead of reporting an empty worker set as healthy.
const startedWorkers = [
  startDetailFetchWorker({ providers }),
  startParserWorker(),
  startRatingWorker(),
  startMaintenanceWorker(),
  startLivenessWorker({ providers }),
  startNotificationDispatcher(),
  marketModelWorker,
];
expectWorkers(startedWorkers.filter(Boolean));

// Initialize the scrape/capture producer (schedules and bus listeners).
initJobExecutionService({ providers, settings, intervalMs: INTERVAL });
