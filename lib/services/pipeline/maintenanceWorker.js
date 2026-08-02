/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { runDbMaintenance } from '../maintenance/databaseCleanup.js';
import { buildDatabaseMaintenanceReport, recordDataIntegrityVerdict } from '../maintenance/databaseReport.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { env } from '../../shared/env.js';
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
      // The upkeep pass has the database warm and the expensive integrity
      // checks are affordable exactly once a day, so this is where the verdict
      // /health serves gets produced.
      const report = buildDatabaseMaintenanceReport(SqliteConnection.getConnection());
      recordDataIntegrityVerdict(report);
      completeWork(WORK_KIND, item.key, { action: 'maintained', patch: { summary, healthy: report.healthy } });
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

function enqueueMaintenance(intervalMs) {
  const scheduledAt = Date.now();
  const key = String(Math.floor(scheduledAt / intervalMs));
  enqueueWork(WORK_KIND, key, { scheduledAt }, { mode: 'ignore' });
}
