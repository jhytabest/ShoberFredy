/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { isUnauthorized, authHook } from '../../lib/api/security.js';

const SESSION_MAX_AGE = 2 * 60 * 60 * 1000; // mirrors security.js

/**
 * Minimal Fastify reply double recording the status code and whether send() was called.
 */
function makeReply() {
  return {
    statusCode: null,
    sent: false,
    code(c) {
      this.statusCode = c;
      return this;
    },
    send() {
      this.sent = true;
      return this;
    },
  };
}

const freshSession = () => ({ currentUser: 'user-1', createdAt: Date.now() });
const expiredSession = () => ({ currentUser: 'user-1', createdAt: Date.now() - (SESSION_MAX_AGE + 1000) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isUnauthorized', () => {
  it('is unauthorized when there is no session', () => {
    expect(isUnauthorized({})).toBe(true);
  });

  it('is unauthorized when the session has no currentUser', () => {
    expect(isUnauthorized({ session: { createdAt: Date.now() } })).toBe(true);
  });

  it('is unauthorized when the session is older than the max age (hard expiry)', () => {
    expect(isUnauthorized({ session: expiredSession() })).toBe(true);
  });

  it('is authorized for a fresh session', () => {
    expect(isUnauthorized({ session: freshSession() })).toBe(false);
  });
});

describe('authHook', () => {
  it('short-circuits the lifecycle by returning the reply when unauthorized', async () => {
    const reply = makeReply();
    const result = await authHook({ session: expiredSession() }, reply);

    // Returning the reply is what tells Fastify to stop and NOT run the route handler.
    expect(result).toBe(reply);
    expect(reply.statusCode).toBe(401);
    expect(reply.sent).toBe(true);
  });

  it('does not touch the reply for an authorized request', async () => {
    const reply = makeReply();
    const result = await authHook({ session: freshSession() }, reply);

    expect(result).toBeUndefined();
    expect(reply.statusCode).toBeNull();
    expect(reply.sent).toBe(false);
  });
});
