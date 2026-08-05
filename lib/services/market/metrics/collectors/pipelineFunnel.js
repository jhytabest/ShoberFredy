/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { columnExists, tableExists } from '../../../../shared/sqlite.js';
import { addHeader, metric } from '../promText.js';

const STAGES = [
  { stage: 'sources', order: 0, table: 'listing_sources', sql: 'SELECT COUNT(*) AS n FROM listing_sources' },
  {
    stage: 'card_rejected',
    order: 1,
    table: 'source_rejections',
    sql: 'SELECT COUNT(*) AS n FROM source_rejections',
  },
  { stage: 'listings', order: 2, table: 'listings', sql: 'SELECT COUNT(*) AS n FROM listings' },
  {
    stage: 'llm_extracted',
    order: 3,
    table: 'listing_extractions',
    sql: 'SELECT COUNT(*) AS n FROM listing_extractions WHERE llm_json IS NOT NULL',
  },
  {
    stage: 'accepted',
    order: 4,
    table: 'listing_verdicts',
    sql: "SELECT COUNT(DISTINCT listing_id) AS n FROM listing_verdicts WHERE verdict = 'accepted'",
  },
];

export function collectPipelineFunnel(lines, { db }) {
  emitFunnel(lines, db);
  emitRejections(lines, db);
  emitRejectionTerms(lines, db);
}

function emitFunnel(lines, db) {
  addHeader(lines, 'fredy_pipeline_funnel', 'gauge', 'Adverts surviving each pipeline stage, cumulative.');
  for (const { stage, order, table, sql } of STAGES) {
    if (!tableExists(db, table)) continue;
    metric(lines, 'fredy_pipeline_funnel', db.prepare(sql).get().n, { stage, order: String(order) });
  }
}

function emitRejections(lines, db) {
  addHeader(lines, 'fredy_rejections', 'gauge', 'Refusals by subject, stage and reason code.');
  if (tableExists(db, 'source_rejections')) {
    const rows = db.prepare('SELECT stage, reason, COUNT(*) AS n FROM source_rejections GROUP BY 1, 2').all();
    for (const row of rows) {
      metric(lines, 'fredy_rejections', row.n, { subject: 'source', stage: row.stage, reason: row.reason });
    }
  }
  if (tableExists(db, 'listing_verdicts')) {
    const rows = db
      .prepare("SELECT stage, reason, COUNT(*) AS n FROM listing_verdicts WHERE verdict = 'rejected' GROUP BY 1, 2")
      .all();
    for (const row of rows) {
      metric(lines, 'fredy_rejections', row.n, {
        subject: 'listing',
        stage: row.stage,
        reason: row.reason ?? 'unknown',
      });
    }
  }
}

function emitRejectionTerms(lines, db) {
  const sources = tableExists(db, 'source_rejections') && columnExists(db, 'source_rejections', 'reason_term');
  const verdicts = tableExists(db, 'listing_verdicts') && columnExists(db, 'listing_verdicts', 'reason_term');
  if (!sources && !verdicts) return;
  addHeader(lines, 'fredy_rejections_by_term', 'gauge', 'Refusals by reason code and the term that fired.');
  const emit = (table, extra) => {
    const rows = db
      .prepare(
        `SELECT reason, reason_term, COUNT(*) AS n FROM ${table}
         WHERE reason_term IS NOT NULL ${extra} GROUP BY 1, 2`,
      )
      .all();
    for (const row of rows) {
      metric(lines, 'fredy_rejections_by_term', row.n, { reason: row.reason, reason_term: row.reason_term });
    }
  };
  if (sources) emit('source_rejections', '');
  if (verdicts) emit('listing_verdicts', "AND verdict = 'rejected'");
}
