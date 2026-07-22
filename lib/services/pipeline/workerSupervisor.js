/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { withOperationDeadline } from './operationDeadline.js';

const workers = new Map();

export function registerWorker(name, { maxOperationMs }) {
  const now = Date.now();
  workers.set(name, {
    name,
    maxOperationMs,
    startedAt: now,
    lastHeartbeatAt: now,
    lastProgressAt: null,
    activeItemId: null,
    activeSince: null,
    completedItems: 0,
    failedItems: 0,
    loopRestarts: 0,
    lastError: null,
  });
}

export function heartbeatWorker(name) {
  const worker = workers.get(name);
  if (worker) worker.lastHeartbeatAt = Date.now();
}

export function recordWorkerLoopRestart(name, error) {
  const worker = workers.get(name);
  if (!worker) return;
  worker.loopRestarts++;
  worker.lastError = String(error?.message || error).slice(0, 1000);
  worker.lastHeartbeatAt = Date.now();
}

export async function superviseWorkerItem(name, itemId, operation, { timeoutMs } = {}) {
  const worker = workers.get(name);
  if (!worker) throw new Error(`Worker '${name}' is not registered`);
  const effectiveTimeout = timeoutMs || worker.maxOperationMs;
  worker.activeItemId = itemId == null ? null : String(itemId);
  worker.activeSince = Date.now();
  worker.lastHeartbeatAt = worker.activeSince;
  try {
    const result = await withOperationDeadline(operation, {
      timeoutMs: effectiveTimeout,
      name: `${name} item '${worker.activeItemId || 'unknown'}'`,
    });
    worker.completedItems++;
    worker.lastProgressAt = Date.now();
    worker.lastError = null;
    return result;
  } catch (error) {
    worker.failedItems++;
    worker.lastProgressAt = Date.now();
    worker.lastError = String(error?.message || error).slice(0, 1000);
    throw error;
  } finally {
    worker.activeItemId = null;
    worker.activeSince = null;
    worker.lastHeartbeatAt = Date.now();
  }
}

export function getWorkerHealth(now = Date.now()) {
  const rows = [...workers.values()].map((worker) => {
    const activeAgeMs = worker.activeSince == null ? 0 : Math.max(0, now - worker.activeSince);
    const heartbeatAgeMs = Math.max(0, now - worker.lastHeartbeatAt);
    const allowedHeartbeatAgeMs = worker.activeSince == null ? 30_000 : worker.maxOperationMs + 30_000;
    return {
      ...worker,
      activeAgeMs,
      heartbeatAgeMs,
      healthy: heartbeatAgeMs <= allowedHeartbeatAgeMs && activeAgeMs <= worker.maxOperationMs + 30_000,
    };
  });
  return { healthy: rows.every((worker) => worker.healthy), workers: rows };
}
