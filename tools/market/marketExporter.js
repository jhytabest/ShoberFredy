/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * CLI wrapper around lib/services/market/metricsExporter.js for running the
 * Prometheus exporter as its own process. The single-container deployment
 * starts it in-process from index.js instead.
 *
 * Usage: node tools/market/marketExporter.js
 * Env: FREDY_MARKET_DB_PATH, FREDY_MARKET_EXPORTER_PORT (default 9217)
 */

import { startMetricsExporter } from '../../lib/services/market/metricsExporter.js';

const server = await startMetricsExporter();
if (!server) {
  throw new Error('Metrics exporter is disabled (FREDY_MARKET_EXPORTER_PORT=0)');
}
process.send?.({ type: 'market_metrics_ready', port: server.address().port });
