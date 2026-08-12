/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export class LockBusyError extends Error {
  constructor(timeoutMs) {
    super(`Lock was not free within ${timeoutMs}ms`);
    this.name = 'LockBusyError';
    this.code = 'LOCK_BUSY';
    this.timeoutMs = timeoutMs;
  }
}

// A promise-chain mutex with a bounded wait. Separate from the browser it guards
// so that "the lock is always released" is a property something can test without
// launching Chromium — the version of this welded into the browser module could
// be left permanently held by an operation that never settled, and nothing
// caught it.
export function createSessionLock() {
  let tail = Promise.resolve();

  return {
    // Resolves to the release function. Callers must release in a `finally`.
    async acquire(timeoutMs) {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => {
        release = resolve;
      });

      try {
        await withTimeout(previous, timeoutMs);
      } catch {
        // Free our own link before giving up, so a caller that timed out cannot
        // itself become the blockage the next caller waits behind.
        release();
        throw new LockBusyError(timeoutMs);
      }
      return release;
    },
  };
}

function withTimeout(promise, timeoutMs) {
  if (!(timeoutMs > 0)) return promise;
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new LockBusyError(timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}
