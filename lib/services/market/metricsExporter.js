/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Prometheus exporter for the Shoberfredy listings database and market model.
 *
 * Entry point only: this module exists so importers keep one stable path while
 * the implementation lives in metrics/. Started in-process by index.js via
 * metricsExporterSupervisor.js (single-container mode) or standalone via
 * tools/market/marketExporter.js.
 *
 *   metrics/metricsServer.js        the /metrics endpoint and the db handle
 *   metrics/registry.js             the collector list
 *   metrics/promText.js             Prometheus text-format primitives
 *   metrics/collectors/*.js         one file per subject area
 *
 * Env: FREDY_MARKET_DB_PATH, FREDY_MARKET_EXPORTER_PORT (default 9217, 0 disables)
 */

export { startMetricsExporter, updateRuntimeHealthSnapshot } from './metrics/metricsServer.js';
