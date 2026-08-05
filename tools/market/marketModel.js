/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { initMarketModel, runMarketModelOnce, getMarketModelStatus } from '../../lib/services/market/marketModel.js';

await initMarketModel();

const mode = process.argv[2] || 'run';
if (mode === 'run') {
  await runMarketModelOnce();
} else if (mode === 'status') {
  console.log(JSON.stringify(getMarketModelStatus(), null, 2));
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
