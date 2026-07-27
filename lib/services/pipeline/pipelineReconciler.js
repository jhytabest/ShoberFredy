/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { getJob } from '../storage/jobStorage.js';
import logger from '../logger.js';
import { captureVersionHash } from './queueStorage.js';
import { markPreLlmHidden } from './sourceAudit.js';
import { extractDeterministicDetail } from './deterministicDetail.js';
import { preLlmFilterReasons, primaryFilterReason } from './listingFilters.js';

/** Reassert terminal pre-LLM filters before continuous workers start. */
export function reconcileTerminalPipeline() {
  const db = SqliteConnection.getConnection();
  const rows = db.prepare("SELECT * FROM detail_fetch_queue WHERE status IN ('pending', 'retry', 'processing')").all();
  const jobs = new Map();
  let filtered = 0;
  for (const row of rows) {
    const detail = { ...row, discovery: parse(row.discovery_json, {}) };
    if (!jobs.has(row.job_id)) jobs.set(row.job_id, getJob(row.job_id));
    const capture = parse(row.capture_json, {});
    // Area (async geocoding) is intentionally not reasserted here so the
    // reconciler stays synchronous; a post-restart listing costs at most one
    // otherwise-skippable LLM call.
    const deterministic = extractDeterministicDetail(capture, detail.discovery);
    const reasons = preLlmFilterReasons(detail.discovery, jobs.get(row.job_id), deterministic);
    if (!reasons.length) continue;
    const reason = primaryFilterReason(reasons);
    const sourceHash = captureVersionHash(row.provider, row.source_key, {
      sourceUrl: row.source_url,
      fullText: capture.fullText || '',
      embeddedData: capture.embeddedData || [],
    });
    markPreLlmHidden(detail, sourceHash, capture, reason, reasons);
    filtered++;
  }
  if (filtered) logger.info(`Removed ${filtered} terminal filter match(es) from active detail work at startup.`);
  return filtered;
}

function parse(value, fallback) {
  try {
    return JSON.parse(value || '') ?? fallback;
  } catch {
    return fallback;
  }
}
