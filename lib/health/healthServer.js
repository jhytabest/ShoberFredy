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
import logger from '../services/logger.js';

/**
 * Provider discovery health, including providers that never got as far as
 * discovery.
 *
 * The circuit breaker only knows a provider once that provider has succeeded or
 * failed at least once. One that is skipped for want of a proxy does neither, so
 * it was absent from this array entirely and the `awaitingProxy` flag — added to
 * report exactly that state — could never be true. Immowelt was invisible here
 * for the whole time it was down.
 *
 * @returns {{provider: string, pausedForMs: number, failures: number,
 *            lastSuccessAgeMs: number|null, awaitingProxy: boolean}[]}
 */
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
 * Two further things are reported without being fatal, because both describe a
 * working process producing less than it should. `providers` carries the age of
 * each provider's last successful discovery: a blocked portal drains its queue,
 * beats every heartbeat and reports ok while a quarter of the market goes unseen,
 * which is how Immowelt stayed down for eleven hours. `data` carries the verdict
 * scheduled maintenance last recorded, so this endpoint and `yarn maintenance
 * status` stop disagreeing about the same database. Neither may fail a deploy —
 * yesterday's claim coverage is not a reason to refuse today's build — but both
 * are now scrapeable.
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
