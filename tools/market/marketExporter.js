/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { startMetricsExporter, updateRuntimeHealthSnapshot } from '../../lib/services/market/metricsExporter.js';

process.on('message', (message) => {
  if (message?.type === 'fredy_runtime_health') updateRuntimeHealthSnapshot(message);
});

const server = await startMetricsExporter();
if (!server) {
  throw new Error('Metrics exporter is disabled (FREDY_MARKET_EXPORTER_PORT=0)');
}
process.send?.({ type: 'market_metrics_ready', port: server.address().port });
