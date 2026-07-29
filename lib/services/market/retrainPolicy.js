/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * When retraining may run. Its own module because both sides need it and they
 * must not import each other: the scheduler lives in the main process and must
 * never pull in the model (corpus + both trainers), which is exactly what it
 * exists to keep out.
 */

import { env } from '../../shared/env.js';

/**
 * Minimum seconds between retrains; 0 means retraining is switched off.
 *
 * @returns {number} seconds, or 0 when disabled
 */
export function marketModelIntervalSeconds() {
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
