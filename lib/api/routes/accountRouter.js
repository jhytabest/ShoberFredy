/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as userStorage from '../../services/storage/userStorage.js';
import logger from '../../services/logger.js';

export default async function accountPlugin(fastify) {
  fastify.get('/', async (request, reply) => {
    const user = userStorage.getUser(request.session.currentUser);
    if (!user) return reply.code(404).send({ error: 'Account not found' });
    return { username: user.username };
  });

  fastify.post('/', async (request, reply) => {
    const userId = request.session.currentUser;
    const username = String(request.body?.username || '').trim();
    const password = String(request.body?.password || '');
    const password2 = String(request.body?.password2 || '');
    if (!username) return reply.code(400).send({ error: 'Username is required.' });
    if (password !== password2) return reply.code(400).send({ error: 'Passwords do not match.' });
    try {
      userStorage.upsertUser({ userId, username, password, isAdmin: true });
      return reply.send();
    } catch (error) {
      logger.error('Could not update the account', error);
      return reply.code(500).send({ error: error?.message || 'Could not update the account.' });
    }
  });
}
