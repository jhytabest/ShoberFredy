/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Fastify from 'fastify';
import SqliteConnection from '../services/storage/SqliteConnection.js';
import { getMigrationStatus } from '../services/storage/migrations/migrate.js';
import { getGeocodingHealth } from '../services/geocoding/geoCodingService.js';
import { getWorkerHealth } from '../services/pipeline/workerSupervisor.js';
import { lastDataIntegrityVerdict } from '../services/maintenance/databaseReport.js';
import { providerDiscoveryHealth } from '../services/jobs/providerHealth.js';
import { providersAwaitingProxy } from '../services/jobs/jobExecutionService.js';
import { proxyHealth } from '../services/extractor/proxySettings.js';
import logger from '../services/logger.js';

function discoveryHealthIncludingIdle() {
  const awaitingProxy = providersAwaitingProxy();
  const known = providerDiscoveryHealth().map((provider) => ({
    ...provider,
    awaitingProxy: awaitingProxy.includes(provider.provider),
  }));
  const seen = new Set(known.map((provider) => provider.provider));
  const idle = awaitingProxy
    .filter((provider) => !seen.has(provider))
    .map((provider) => ({
      provider,
      pausedForMs: 0,
      failures: 0,
      lastSuccessAgeMs: null,
      awaitingProxy: true,
    }));
  return [...known, ...idle].sort((left, right) => left.provider.localeCompare(right.provider));
}

export async function startHealthServer(port) {
  const fastify = Fastify({ logger: false });

  fastify.get('/health', async (_request, reply) => {
    const workers = getWorkerHealth();
    const geocoding = getGeocodingHealth();
    const checks = { database: false, schema: false, geocoding: geocoding.configured, workers: workers.healthy };
    let schema = null;
    let data = null;

    try {
      const db = SqliteConnection.getConnection();
      db.prepare('SELECT 1').get();
      checks.database = true;
      schema = getMigrationStatus(db);
      checks.schema = schema.upToDate;
      data = lastDataIntegrityVerdict(db);
    } catch (error) {
      logger.error('Health check database probe failed', error);
    }

    const healthy = Object.values(checks).every(Boolean);
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'unhealthy',
      checks,
      geocoding: { configured: geocoding.configured, available: geocoding.healthy },
      schema,
      data: data ? { ...data, ageMs: Date.now() - data.checkedAt } : null,
      proxy: proxyHealth(),
      providers: discoveryHealthIncludingIdle(),
      workersMissing: workers.missing,
      workers: workers.workers.map((worker) => ({
        name: worker.name,
        healthy: worker.healthy,
        active: worker.activeItemId != null,
        activeAgeMs: worker.activeAgeMs,
        heartbeatAgeMs: worker.heartbeatAgeMs,
        completedItems: worker.completedItems,
        failedItems: worker.failedItems,
        loopRestarts: worker.loopRestarts,
      })),
    });
  });

  await fastify.listen({ port, host: '0.0.0.0' });
  logger.info(`Health endpoint listening on :${port}/health`);
  return fastify;
}
