/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Child-process entrypoint used by the durable market-model worker, plus
 * read-only status inspection.
 *
 * Usage: node tools/market/marketModel.js [run|status]
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
