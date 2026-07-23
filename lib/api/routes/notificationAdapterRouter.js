/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../../services/logger.js';
import * as telegram from '../../notification/adapter/telegram.js';

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function notificationAdapterPlugin(fastify) {
  fastify.post('/test', async (request, reply) => {
    const fields = request.body?.fields || {};
    try {
      await telegram.send({
        serviceName: 'Telegram test',
        newListings: [
          {
            address: 'Heidestrasse 17, 51147 Köln',
            id: '1',
            price: '1.000 €',
            size: '76 m²',
            title: 'Stilvolle gepflegte 3-Raum-Wohnung mit gehobener Innenausstattung',
            link: 'https://www.orange-coding.net',
          },
        ],
        notificationConfig: [{ id: 'telegram', name: 'Telegram', fields }],
        jobKey: 'TestJob',
      });
      return reply.send();
    } catch (error) {
      logger.error('Error during Telegram test:', error);
      return reply.code(500).send({ error: error?.message || String(error) });
    }
  });
}
