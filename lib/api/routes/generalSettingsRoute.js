/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getDirName } from '../../utils.js';
import fs from 'fs';
import logger from '../../services/logger.js';
import { getSettings, upsertSettings } from '../../services/storage/settingsStorage.js';

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function generalSettingsPlugin(fastify) {
  fastify.get('/', async () => {
    return Object.assign({}, await getSettings());
  });

  fastify.post('/', async (request, reply) => {
    const { sqlitepath, ...appSettings } = request.body || {};
    if (typeof appSettings.baseUrl === 'string') {
      appSettings.baseUrl = appSettings.baseUrl.trim().replace(/\/$/, '');
    }
    try {
      if (typeof sqlitepath !== 'undefined') {
        fs.writeFileSync(`${getDirName()}/../conf/config.json`, JSON.stringify({ sqlitepath }));
      }

      upsertSettings(appSettings);
    } catch (err) {
      logger.error(err);
      return reply.code(500).send({ error: 'Error while trying to write settings.' });
    }
    return reply.send();
  });
}
