/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';

/*
 * A provider that is blocked or whose markup has changed fails identically for
 * every job, but the scheduler used to discover that once per job: three jobs
 * meant three full navigations, three deadline waits, and three browser-session
 * resets every hour, all to learn the same fact. The cost is paid in wall-clock
 * time on the shared browser, so it delays the providers that do work.
 *
 * The breaker records the outcome per provider and opens after a couple of
 * consecutive empty runs, then backs off. Discovery is still retried on a
 * schedule, so a provider that recovers comes back on its own with no operator
 * action — the point is to stop paying full price while it is down.
 */

const OPEN_AFTER_FAILURES = positiveEnv('FREDY_PROVIDER_BREAKER_FAILURES', 2);
const BASE_COOLDOWN_MS = positiveEnv('FREDY_PROVIDER_BREAKER_COOLDOWN_MS', 30 * 60 * 1000);
const MAX_COOLDOWN_MS = positiveEnv('FREDY_PROVIDER_BREAKER_MAX_COOLDOWN_MS', 6 * 60 * 60 * 1000);

/** @type {Map<string, {failures: number, openUntil: number}>} */
const state = new Map();

function entry(providerId) {
  let value = state.get(providerId);
  if (!value) {
    value = { failures: 0, openUntil: 0 };
    state.set(providerId, value);
  }
  return value;
}

/**
 * Whether discovery for this provider should be skipped right now.
 *
 * @param {string} providerId
 * @param {number} [now]
 * @returns {boolean}
 */
export function isProviderPaused(providerId, now = Date.now()) {
  return entry(providerId).openUntil > now;
}

/**
 * How much longer the provider stays paused, for logging.
 *
 * @param {string} providerId
 * @param {number} [now]
 * @returns {number} milliseconds, 0 when not paused
 */
export function pausedForMs(providerId, now = Date.now()) {
  return Math.max(0, entry(providerId).openUntil - now);
}

/**
 * Record a discovery run that produced usable cards. Closes the breaker.
 *
 * @param {string} providerId
 * @returns {void}
 */
export function recordProviderSuccess(providerId) {
  const value = entry(providerId);
  if (value.failures > 0 || value.openUntil > 0) {
    logger.info(`Provider '${providerId}' is answering again; clearing its discovery pause.`);
  }
  value.failures = 0;
  value.openUntil = 0;
}

/**
 * Record a discovery run that yielded nothing usable (challenge, deadline, or
 * markup change). Opens the breaker once the failures pile up.
 *
 * @param {string} providerId
 * @param {string} reason
 * @param {number} [now]
 * @returns {void}
 */
export function recordProviderFailure(providerId, reason, now = Date.now()) {
  const value = entry(providerId);
  value.failures += 1;
  if (value.failures < OPEN_AFTER_FAILURES) return;

  const cooldown = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** (value.failures - OPEN_AFTER_FAILURES));
  value.openUntil = now + cooldown;
  logger.warn(
    `Provider '${providerId}' produced nothing on ${value.failures} consecutive discovery runs (${reason}). ` +
      `Pausing its discovery for ${Math.round(cooldown / 60000)} min.`,
  );
}

/** Test/operator hook: forget all breaker state. */
export function resetProviderBreakers() {
  state.clear();
}

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
