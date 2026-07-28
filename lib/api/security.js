/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Returns true when the request has no valid, non-expired session.
 * @param {import('fastify').FastifyRequest} request
 * @param {number} maxAgeMs
 * @returns {boolean}
 */
export function isUnauthorized(request, maxAgeMs) {
  if (!request.session?.currentUser) return true;
  if (Date.now() - (request.session.createdAt || 0) > maxAgeMs) return true;
  return false;
}

/**
 * Build the authentication hook from the same lifetime used by the session
 * cookie. There is one source of truth for both client and server expiry.
 * @param {number} maxAgeMs
 */
export function createAuthHook(maxAgeMs) {
  return async function authHook(request, reply) {
    if (isUnauthorized(request, maxAgeMs)) return reply.code(401).send();
  };
}
