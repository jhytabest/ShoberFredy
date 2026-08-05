/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { addHeader, metric } from './promText.js';
import { collectPipelineHealth } from './collectors/pipelineHealth.js';
import { collectPipelineFunnel } from './collectors/pipelineFunnel.js';
import { collectListingInventory } from './collectors/listingInventory.js';
import { collectModelMetrics } from './collectors/modelMetrics.js';

const COLLECTORS = [collectPipelineHealth, collectPipelineFunnel, collectListingInventory, collectModelMetrics];

export function collectMetrics(context) {
  const startedAt = performance.now();
  const lines = [];

  emitExporterStatus(lines, { up: 1, collectionErrors: context.collectionErrors });
  for (const collect of COLLECTORS) collect(lines, context);

  addHeader(lines, 'fredy_market_collection_duration_seconds', 'gauge', 'Duration of the latest metrics collection.');
  metric(lines, 'fredy_market_collection_duration_seconds', (performance.now() - startedAt) / 1000);

  return `${lines.join('\n')}\n`;
}

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
