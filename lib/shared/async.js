/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { env } from './env.js';

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with jitter, capped.
 *
 * The cap matters as much as the growth: a listing still unreachable an hour
 * later is almost never worth a six-hour wait as well, because rentals leave the
 * market faster than that and the late attempt lands on a dead page. Jitter
 * spreads a batch of items that all failed at the same moment.
 *
 * @param {number} attempt zero-based attempt count already made
 * @param {number} [capMs] ceiling; defaults to FREDY_WORK_MAX_BACKOFF_MS
 * @returns {number} milliseconds to wait
 */
export function backoffMs(attempt, capMs = env('FREDY_WORK_MAX_BACKOFF_MS')) {
  const exponent = Math.min(Math.max(Number(attempt) || 0, 0), 6);
  const base = Math.min(capMs, 60_000 * 2 ** exponent);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}
