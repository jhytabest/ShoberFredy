/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'fs';
import sharp from 'sharp';
import { checkIfConfigIsAccessible, getProviders, refreshConfig } from './lib/utils.js';
import { runMigrations } from './lib/services/storage/migrations/migrate.js';
import logger from './lib/services/logger.js';
import SqliteConnection, { computeDbPath } from './lib/services/storage/SqliteConnection.js';
import { SCHEDULER_WORKER, initJobExecutionService } from './lib/services/jobs/jobExecutionService.js';
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

// libvips defaults are sized for a machine that exists to process images: a
// cache measured in hundreds of megabytes and one worker thread per core. This
// process resizes a handful of listing photos between long idle stretches on a
// 3.7 GiB host, and the cache is never warm when it matters — it only ratchets
// RSS up and never gives it back. One thread, no cache.
sharp.cache(false);
sharp.concurrency(1);

logger.info('Checking CloakBrowser binary...');
await ensureValidBinary();
logger.info('CloakBrowser binary ready.');

const isConfigAccessible = await checkIfConfigIsAccessible();
if (!isConfigAccessible) {
  logger.error('Configuration exists, but is not accessible. Please check the file permission');
  process.exit(1);
}
await refreshConfig();
await SqliteConnection.init();

await runMigrations();
if (process.exitCode) {
  throw new Error('Database migrations failed; refusing to start against an incomplete schema.');
}

const { dir: sqliteDir } = await computeDbPath();
if (!fs.existsSync(sqliteDir)) {
  fs.mkdirSync(sqliteDir, { recursive: true });
}

const providers = await getProviders();

await startHealthServer(env('FREDY_HEALTH_PORT'));

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

const startedWorkers = [
  startDetailFetchWorker({ providers }),
  startParserWorker(),
  startRatingWorker(),
  startMaintenanceWorker(),
  startLivenessWorker({ providers }),
  startNotificationDispatcher(),
  marketModelWorker,
];
initJobExecutionService({ providers });

// After initJobExecutionService, which is what registers the scheduler.
expectWorkers([...startedWorkers.filter(Boolean), SCHEDULER_WORKER]);
