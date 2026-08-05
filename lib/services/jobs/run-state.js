/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const running = new Set();

export function isRunning(jobId) {
  return running.has(jobId);
}

export function markRunning(jobId) {
  if (running.has(jobId)) return false;
  running.add(jobId);
  return true;
}

export function markFinished(jobId) {
  running.delete(jobId);
}
