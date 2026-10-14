/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { createServer } from 'node:http';
import SqliteConnection from '../services/storage/SqliteConnection.js';
import logger from '../services/logger.js';

export async function startHealthServer(port) {
  const server = createServer((request, response) => {
    if (request.url !== '/health' || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end();
      return;
    }
    let status = 'ok';
    try {
      SqliteConnection.getConnection().prepare('SELECT 1').get();
    } catch {
      status = 'unavailable';
    }
    response.writeHead(status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ status }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  logger.info(`Docker health endpoint listening on :${port}/health`);
  return server;
}
