/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * The collector list. This is the only file that knows which collectors exist;
 * adding a metric family means adding it to one collector, and adding a
 * collector means adding one line here.
 *
 * Collectors are called in order and share nothing but the context, so a query
 * added to one can never change what another publishes.
 */

import { addHeader, metric } from './promText.js';
import { collectPipelineHealth } from './collectors/pipelineHealth.js';
import { collectListingInventory } from './collectors/listingInventory.js';
import { collectModelMetrics } from './collectors/modelMetrics.js';

const COLLECTORS = [collectPipelineHealth, collectListingInventory, collectModelMetrics];

/**
 * Render one complete Prometheus response.
 *
 * Collectors are not individually try/caught: a query that throws means the
 * database is not in the shape this build expects, and reporting a partial
 * scrape as a successful one would hide that. The caller turns the throw into
 * exporter_up=0 (see emitExporterStatus).
 *
 * @param {{db: import('better-sqlite3').Database, runtimeSnapshot: object|null,
 *   collectionErrors: number}} context
 * @returns {string}
 */
export function collectMetrics(context) {
  const startedAt = performance.now();
  const lines = [];

  emitExporterStatus(lines, { up: 1, collectionErrors: context.collectionErrors });
  for (const collect of COLLECTORS) collect(lines, context);

  addHeader(lines, 'fredy_market_collection_duration_seconds', 'gauge', 'Duration of the latest metrics collection.');
  metric(lines, 'fredy_market_collection_duration_seconds', (performance.now() - startedAt) / 1000);

  return `${lines.join('\n')}\n`;
}

/**
 * The three series that must be present on every scrape, successful or not —
 * they are what an alert queries when everything else is missing.
 *
 * @param {string[]} lines
 * @param {{up: 0|1, collectionErrors: number}} status
 */
export function emitExporterStatus(lines, { up, collectionErrors }) {
  addHeader(lines, 'fredy_market_exporter_up', 'gauge', 'Whether the market exporter can read the listings database.');
  metric(lines, 'fredy_market_exporter_up', up);
  addHeader(
    lines,
    'fredy_market_last_scrape_timestamp_seconds',
    'gauge',
    'Unix timestamp of the latest market exporter scrape.',
  );
  metric(lines, 'fredy_market_last_scrape_timestamp_seconds', Math.floor(Date.now() / 1000));
  addHeader(
    lines,
    'fredy_market_collection_errors_total',
    'counter',
    'Metrics collection failures since exporter start.',
  );
  metric(lines, 'fredy_market_collection_errors_total', collectionErrors);
}
