/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationDeadlineError, withOperationDeadline } from '../lib/services/pipeline/operationDeadline.js';

test('a deadline aborts the signal it hands the operation', async () => {
  let seen = null;

  await assert.rejects(
    () =>
      withOperationDeadline(
        (signal) => {
          seen = signal;
          return new Promise(() => {}); // never settles, like a wedged CDP call
        },
        { timeoutMs: 20, name: 'discovery:test' },
      ),
    OperationDeadlineError,
  );

  // Discovery took the signal as an unused parameter, so nothing downstream ever
  // learned the deadline had passed and the work carried on holding the browser.
  assert.ok(seen, 'the operation must be given a signal');
  assert.equal(seen.aborted, true, 'the signal must be aborted when the deadline fires');
  assert.ok(seen.reason instanceof OperationDeadlineError);
});

test('an operation that finishes in time keeps its signal unaborted', async () => {
  let seen = null;

  const result = await withOperationDeadline(
    (signal) => {
      seen = signal;
      return Promise.resolve('done');
    },
    { timeoutMs: 1000, name: 'discovery:test' },
  );

  assert.equal(result, 'done');
  assert.equal(seen.aborted, false);
});

test('a parent abort propagates to the operation', async () => {
  const parent = new AbortController();
  let seen = null;

  const pending = assert.rejects(() =>
    withOperationDeadline(
      (signal) => {
        seen = signal;
        return new Promise(() => {});
      },
      { timeoutMs: 5000, signal: parent.signal, name: 'discovery:test' },
    ),
  );

  parent.abort(new Error('shutting down'));
  await pending;

  assert.equal(seen.aborted, true);
});
