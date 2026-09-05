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
import { getJobs } from '../services/storage/jobStorage.js';
import { jobDiscoveryHealth, providerDiscoveryHealth } from '../services/jobs/providerHealth.js';
import logger from '../services/logger.js';

function discoveryHealth() {
  return providerDiscoveryHealth().sort((left, right) => left.provider.localeCompare(right.provider));
}

export async function startHealthServer(port) {
  const fastify = Fastify({ logger: false });

  fastify.get('/health', async (_request, reply) => {
    const workers = getWorkerHealth();
    const geocoding = getGeocodingHealth();
    const checks = { database: false, schema: false, geocoding: geocoding.configured, workers: workers.healthy };
    let schema = null;
    let data = null;
    let searches = [];

    try {
      const db = SqliteConnection.getConnection();
      db.prepare('SELECT 1').get();
      checks.database = true;
      schema = getMigrationStatus(db);
      checks.schema = schema.upToDate;
      data = lastDataIntegrityVerdict(db);
      searches = jobDiscoveryHealth(getJobs());
    } catch (error) {
      logger.error('Health check database probe failed', error);
    }

    const healthy = Object.values(checks).every(Boolean);
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? (searches.some((search) => search.needsAttention) ? 'degraded' : 'ok') : 'unhealthy',
      checks,
      geocoding: { configured: geocoding.configured, available: geocoding.healthy },
      schema,
      data: data ? { ...data, ageMs: Date.now() - data.checkedAt } : null,
      providers: discoveryHealth(),
      searches,
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
