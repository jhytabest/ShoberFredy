/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { runDbMaintenance } from '../maintenance/databaseCleanup.js';
import { buildDatabaseMaintenanceReport, recordDataIntegrityVerdict } from '../maintenance/databaseReport.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { env } from '../../shared/env.js';
import { completeWork, enqueueWork, registerHandler, startWorker, SINGLE_ATTEMPT } from './workQueue.js';

const WORK_KIND = 'maintenance';
const WORKER_NAME = 'maintenance';

export function startMaintenanceWorker() {
  registerHandler(WORK_KIND, {
    name: WORKER_NAME,
    enabled: () => env('FREDY_MAINTENANCE_ENABLED'),
    timeoutMs: () => env('FREDY_MAINTENANCE_ITEM_TIMEOUT_MS'),
    maxAttempts: () => SINGLE_ATTEMPT,
    startedMessage: 'Scheduled database-maintenance worker started.',
    handler: (item) => {
      const summary = runDbMaintenance();
      const db = SqliteConnection.getConnection();
      summary.livenessChecks = enqueueLivenessChecks(db);
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

function enqueueLivenessChecks(db) {
  const limit = env('FREDY_LIVENESS_CHECKS_PER_PASS');
  if (limit <= 0) return 0;
  const cutoff = Date.now() - env('FREDY_LIVENESS_STALE_AFTER_MS');
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
