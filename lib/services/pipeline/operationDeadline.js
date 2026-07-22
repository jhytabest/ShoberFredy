/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export class OperationDeadlineError extends Error {
  constructor(operation, timeoutMs) {
    super(`${operation} exceeded its ${timeoutMs}ms deadline`);
    this.name = 'OperationDeadlineError';
    this.code = 'OPERATION_DEADLINE';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Bound an async operation even if the underlying client fails to honour an
 * AbortSignal. The controller still aborts cooperative work; Promise.race is
 * the final guard that gives the caller its worker loop back.
 */
export async function withOperationDeadline(operation, { timeoutMs, signal, name = 'operation' }) {
  const controller = new AbortController();
  let timeout;
  let removeParentAbort = () => {};

  const parentAbort = new Promise((_, reject) => {
    if (!signal) return;
    const abort = () => {
      const reason = abortReason(signal, name);
      controller.abort(reason);
      reject(reason);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    removeParentAbort = () => signal.removeEventListener('abort', abort);
  });

  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new OperationDeadlineError(name, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  const task = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race(signal ? [task, deadline, parentAbort] : [task, deadline]);
  } finally {
    clearTimeout(timeout);
    removeParentAbort();
  }
}

function abortReason(signal, name) {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(`${name} was aborted`);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}
