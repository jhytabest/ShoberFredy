/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Fastify from 'fastify';
import SqliteConnection from '../services/storage/SqliteConnection.js';
import logger from '../services/logger.js';

export async function startHealthServer(port) {
  const fastify = Fastify({ logger: false });
  fastify.get('/health', async (_request, reply) => {
    try {
      SqliteConnection.getConnection().prepare('SELECT 1').get();
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  await fastify.listen({ port, host: '0.0.0.0' });
  logger.info(`Docker health endpoint listening on :${port}/health`);
  return fastify;
}
