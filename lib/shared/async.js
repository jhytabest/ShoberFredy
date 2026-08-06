/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { env } from './env.js';

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One curve for every kind of waiting: retries after a failure and parks on an
// unavailable resource both back off the same way, so there is one formula to
// reason about rather than two that happened to agree.
//
// The cap defaults to the discovery interval. Past one scrape a longer wait buys
// nothing — a changed card resets the item anyway — and only delays work that
// competes with fresher items.
export function backoffMs(attempt, capMs = env('FREDY_WORK_MAX_BACKOFF_MS')) {
  const exponent = Math.min(Math.max(Number(attempt) || 0, 0), 6);
  const base = Math.min(capMs, 60_000 * 2 ** exponent);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}
