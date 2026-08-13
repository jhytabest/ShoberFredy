/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { LockBusyError, createSessionLock } from '../lib/services/extractor/sessionLock.js';

test('holders run one at a time, in the order they queued', async () => {
  const lock = createSessionLock();
  const order = [];

  const hold = async (name, ms) => {
    const release = await lock.acquire(1000);
    order.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(`${name}:end`);
    release();
  };

  await Promise.all([hold('a', 20), hold('b', 1), hold('c', 1)]);

  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
});

test('a holder that throws still frees the lock', async () => {
  const lock = createSessionLock();

  const release = await lock.acquire(1000);
  try {
    throw new Error('operation blew up');
  } catch {
    release();
  }

  // Would hang rather than fail if the rejection had swallowed the release.
  const second = await lock.acquire(50);
  assert.equal(typeof second, 'function');
  second();
});

// The production failure: an operation that never settled kept the lock forever,
// so discovery, detail capture and liveness all queued behind it until restart.
// Every waiter must now give up on its own schedule — while still not being handed
// a lock the stuck holder has not let go of.
test('every waiter fails fast while the holder keeps the lock', async () => {
  const lock = createSessionLock();

  const stuck = await lock.acquire(1000);
  assert.equal(typeof stuck, 'function');

  await assert.rejects(() => lock.acquire(25), LockBusyError);

  // The second waiter is the interesting one. It must not sail through on the
  // first waiter's abandoned link — that would hand it a browser the stuck holder
  // is still using — and it must not wait unbounded either.
  const startedAt = Date.now();
  await assert.rejects(() => lock.acquire(25), LockBusyError);
  assert.ok(Date.now() - startedAt < 500, 'second waiter should fail fast, not wait unbounded');

  stuck();
});

test('the lock recovers once the stuck holder finally releases', async () => {
  const lock = createSessionLock();

  const stuck = await lock.acquire(1000);
  await assert.rejects(() => lock.acquire(10), LockBusyError);
  stuck();

  const release = await lock.acquire(100);
  assert.equal(typeof release, 'function');
  release();
});

test('a zero timeout means wait indefinitely, not fail immediately', async () => {
  const lock = createSessionLock();

  const first = await lock.acquire(0);
  setTimeout(first, 20);

  const second = await lock.acquire(0);
  assert.equal(typeof second, 'function');
  second();
});
