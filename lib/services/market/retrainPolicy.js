/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { env } from '../../shared/env.js';

export function marketModelIntervalSeconds() {
  return env('FREDY_MARKET_MODEL_INTERVAL_SECONDS');
}

export function isRetrainDisabled() {
  return marketModelIntervalSeconds() === 0;
}
