/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * When retraining may run. Its own module because both sides need it and they
 * must not import each other: the scheduler lives in the API process and must
 * never pull in the model (corpus + both trainers), which is exactly what it
 * exists to keep out.
 */

import { env, envIsSet } from '../../shared/env.js';

/**
 * Minimum seconds between retrains; 0 means retraining is switched off.
 *
 * FREDY_MARKET_MODEL_INTERVAL_SECONDS=0 is documented as the kill switch, but
 * `env()` treats a non-positive int as unparsable and falls back to the
 * declared default — so reading it through `env()` alone would silently turn
 * "off" into "every 24 hours". The raw check below is what makes 0 mean 0. It
 * deliberately accepts any non-positive value: someone writing -1 means "off"
 * too, and the previous helper threw on both.
 *
 * @returns {number} seconds, or 0 when disabled
 */
export function marketModelIntervalSeconds() {
  if (envIsSet('FREDY_MARKET_MODEL_INTERVAL_SECONDS')) {
    const raw = Number(process.env.FREDY_MARKET_MODEL_INTERVAL_SECONDS);
    if (Number.isFinite(raw) && raw <= 0) return 0;
  }
  return env('FREDY_MARKET_MODEL_INTERVAL_SECONDS');
}

/**
 * Whether retraining is switched off entirely. Checked both by the scheduler
 * (so no cron is registered) and by the run itself (so the CLI and any other
 * caller honour the same switch).
 *
 * @returns {boolean}
 */
export function isRetrainDisabled() {
  return marketModelIntervalSeconds() === 0;
}
