/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Fastify from 'fastify';
import SqliteConnection from '../services/storage/SqliteConnection.js';
import { getMigrationStatus } from '../services/storage/migrations/migrate.js';
import { getGeocodingHealth } from '../services/geocoding/geoCodingService.js';
import { getWorkerHealth } from '../services/pipeline/workerSupervisor.js';
import logger from '../services/logger.js';

/**
 * All that remains of the HTTP surface.
 *
 * There is no UI and no API: notifications are the product, and Telegram is the
 * only place they go. What still has to exist is a liveness probe, because the
 * container HEALTHCHECK and the deploy gate both read it — a deploy that cannot
 * observe health is a deploy that cannot roll itself back.
 *
 * It answers the four questions that distinguish "running" from "working": is
 * the database reachable, does its schema match this build, is the geocoder
 * configured, and is every worker this process expected to start actually
 * registered and beating. A transient Google outage is deliberately not fatal —
 * treating it as such handed a third party a veto over deployments.
 *
 * @param {number} port
 */
export async function startHealthServer(port) {
  const fastify = Fastify({ logger: false });

  fastify.get('/health', async (_request, reply) => {
    const workers = getWorkerHealth();
    const geocoding = getGeocodingHealth();
    const checks = { database: false, schema: false, geocoding: geocoding.configured, workers: workers.healthy };
    let schema = null;

    try {
      const db = SqliteConnection.getConnection();
      db.prepare('SELECT 1').get();
      checks.database = true;
      schema = getMigrationStatus(db);
      checks.schema = schema.upToDate;
    } catch (error) {
      logger.error('Health check database probe failed', error);
    }

    const healthy = Object.values(checks).every(Boolean);
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'unhealthy',
      checks,
      geocoding: { configured: geocoding.configured, available: geocoding.healthy },
      schema,
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
