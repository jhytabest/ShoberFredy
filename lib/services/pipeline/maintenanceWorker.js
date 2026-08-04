/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { runDbMaintenance } from '../maintenance/databaseCleanup.js';
import { buildDatabaseMaintenanceReport, recordDataIntegrityVerdict } from '../maintenance/databaseReport.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { env } from '../../shared/env.js';
import { runHistoricalBackfill } from '../maintenance/historicalBackfill.js';
import { completeWork, enqueueWork, registerHandler, startWorker } from './workQueue.js';

const WORK_KIND = 'maintenance';
const WORKER_NAME = 'maintenance';

/**
 * Make database upkeep ordinary durable work. There is no operator-triggered
 * mutation path: each interval gets one idempotent item and the shared worker
 * supplies its lease, retry and audit-visible outcome.
 *
 * @returns {string|null}
 */
export function startMaintenanceWorker() {
  registerHandler(WORK_KIND, {
    name: WORKER_NAME,
    enabled: () => env('FREDY_MAINTENANCE_ENABLED'),
    timeoutMs: () => env('FREDY_MAINTENANCE_ITEM_TIMEOUT_MS'),
    maxAttempts: () => env('FREDY_MAINTENANCE_MAX_FAILURES'),
    startedMessage: 'Scheduled database-maintenance worker started.',
    handler: (item) => {
      const summary = runDbMaintenance();
      const db = SqliteConnection.getConnection();
      // Temporary, and marked as such: see historicalBackfill.js for how to
      // delete it once every pass has run.
      Object.assign(summary, runHistoricalBackfill(db));
      summary.livenessChecks = enqueueLivenessChecks(db);
      // The upkeep pass has the database warm and the expensive integrity
      // checks are affordable exactly once a day, so this is where the verdict
      // /health serves gets produced.
      const report = buildDatabaseMaintenanceReport(db);
      recordDataIntegrityVerdict(report);
      completeWork(WORK_KIND, item.key, {
        action: 'maintained',
        code: 'maintained',
        patch: { summary, healthy: report.healthy },
      });
    },
  });
  const worker = startWorker(WORK_KIND);
  if (!worker) return null;

  const intervalMs = env('FREDY_MAINTENANCE_INTERVAL_MS');
  enqueueMaintenance(intervalMs);
  const timer = setInterval(() => enqueueMaintenance(intervalMs), intervalMs);
  timer.unref();
  return worker;
}

/**
 * Ask whether the oldest still-'active' listings are actually still up.
 *
 * `state = 'gone'` had never once been written. The code for it is correct and
 * has always been there, but nothing could reach it: an advert is fetched exactly
 * once and never looked at again, so no capture was ever in a position to observe
 * a listing disappear. 1,011 listings were more than a week stale and 361 more
 * than a month, all of them 'active', all of them still in the training corpus
 * and still able to win a dedupe match against a live advert.
 *
 * The probe is a page fetch and nothing else, so a re-check costs no LLM call.
 * It is its own work kind rather than a flag on a detail item: see
 * `livenessWorker.js` for why a detail capture cannot answer this question.
 *
 * Rate-limited per pass, oldest first, so a backlog of a thousand stale listings
 * drains over days instead of competing with live discovery for the one browser.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number} how many probes were queued
 */
function enqueueLivenessChecks(db) {
  const limit = env('FREDY_LIVENESS_CHECKS_PER_PASS');
  if (limit <= 0) return 0;
  const cutoff = Date.now() - env('FREDY_LIVENESS_STALE_AFTER_MS');
  // Candidates come from `listings`, which carries its own `link` and `provider`
  // on every row. Joining `listing_sources` looked equivalent and was not: the
  // 1,278 listings restored from the pre-migration snapshot have no sources, and
  // they are precisely the stale ones this pass exists to check. The join
  // silently reduced the candidate set to nothing.
  const stale = db
    .prepare(
      `SELECT l.id, l.provider, l.link
       FROM listings l
       WHERE l.state = 'active' AND l.last_seen_at < @cutoff
         AND l.link IS NOT NULL AND l.link != ''
       ORDER BY l.last_seen_at ASC
       LIMIT @limit`,
    )
    .all({ cutoff, limit });

  // Keyed by listing, which is what a probe is about. One row per listing, so a
  // pass that runs while a previous probe is still queued finds the same item
  // rather than opening a second one.
  for (const row of stale) {
    enqueueWork('liveness', row.id, { listingId: row.id, provider: row.provider, link: row.link }, { mode: 'reset' });
  }
  return stale.length;
}

function enqueueMaintenance(intervalMs) {
  const scheduledAt = Date.now();
  const key = String(Math.floor(scheduledAt / intervalMs));
  enqueueWork(WORK_KIND, key, { scheduledAt }, { mode: 'ignore' });
}
