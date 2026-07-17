/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * CLI wrapper around lib/services/market/marketModel.js for manual runs and
 * the (optional) standalone daemon mode. The single-container deployment
 * retrains in-process from index.js instead.
 *
 * Usage: node tools/market/marketModel.js [run|daemon|status]
 */

import {
  initMarketModel,
  runMarketModelOnce,
  runMarketModelDaemon,
  getMarketModelStatus,
} from '../../lib/services/market/marketModel.js';

await initMarketModel();

const mode = process.argv[2] || 'run';
if (mode === 'daemon') {
  await runMarketModelDaemon();
} else if (mode === 'run') {
  await runMarketModelOnce();
} else if (mode === 'status') {
  console.log(JSON.stringify(getMarketModelStatus(), null, 2));
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
