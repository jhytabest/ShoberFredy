/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const SESSION_MAX_AGE = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Returns true when the request has no valid, non-expired session.
 * @param {import('fastify').FastifyRequest} request
 * @returns {boolean}
 */
export function isUnauthorized(request) {
  if (!request.session?.currentUser) return true;
  if (Date.now() - (request.session.createdAt || 0) > SESSION_MAX_AGE) return true;
  return false;
}

/**
 * Fastify preHandler hook - rejects unauthenticated requests with 401.
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function authHook(request, reply) {
  if (isUnauthorized(request)) {
    return reply.code(401).send();
  }
}
