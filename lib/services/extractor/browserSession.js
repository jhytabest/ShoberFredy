/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { closeBrowser, destroyBrowser, launchBrowser } from './puppeteerExtractor.js';
import { LockBusyError, createSessionLock } from './sessionLock.js';
import { ProviderTransientError } from '../pipeline/providerErrors.js';
import logger from '../logger.js';
import { env } from '../../shared/env.js';

let browser = null;
let browserProxy = null;
let idleTimer = null;
let sessionsSinceLaunch = 0;

const lock = createSessionLock();

// Discovery, detail capture and liveness all share one browser behind one lock,
// so a session that never settled used to stall the other two indefinitely: the
// caller's Promise.race rejected on its own deadline while the operation kept
// running, and the release — which only fires once the operation settles — was
// never reached. Every path below now releases, and the ceiling kills the browser
// rather than waiting politely, because a dead browser is what makes a wedged CDP
// call reject and lets an operation nobody can cancel unwind.
export async function withBrowserSession(url, options, operation) {
  let release;
  try {
    release = await lock.acquire(env('FREDY_BROWSER_LOCK_TIMEOUT_MS'));
  } catch (error) {
    if (error instanceof LockBusyError) throw new ProviderTransientError(error.message, { cause: error });
    throw error;
  }

  cancelIdleReap();
  try {
    const proxyUrl = typeof options?.proxyUrl === 'string' ? options.proxyUrl.trim() : '';
    if (browser && (!browser.connected || browserProxy !== proxyUrl)) {
      await closeBrowser(browser);
      forgetBrowser();
    }
    if (browser && sessionsSinceLaunch >= env('FREDY_BROWSER_MAX_SESSIONS')) {
      logger.debug(`Recycling the browser after ${sessionsSinceLaunch} sessions.`);
      await closeBrowser(browser);
      forgetBrowser();
    }
    if (!browser) {
      try {
        browser = await launchBrowser(url, proxyUrl ? { proxyUrl } : {});
      } catch (error) {
        logger.event('browser_launch_failure', 'error', 'Failed to launch the browser process.', error);
        throw error;
      }
      browserProxy = proxyUrl;
      sessionsSinceLaunch = 0;
    }
    sessionsSinceLaunch += 1;
    return await runBounded(browser, operation, options?.signal);
  } finally {
    release();
    scheduleIdleReap();
  }
}

// The session's own ceiling, independent of whatever deadline the caller races.
// On expiry or abort the browser process is destroyed, which rejects every
// in-flight CDP call; the operation is then awaited only long enough to unwind,
// so the caller sees a real error instead of a promise nobody owns.
async function runBounded(current, operation, signal) {
  const timeoutMs = env('FREDY_BROWSER_SESSION_TIMEOUT_MS');
  const task = Promise.resolve().then(() => operation(current));

  let timer;
  let onAbort;
  const tripped = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new ProviderTransientError(`Browser session exceeded its ${timeoutMs}ms ceiling`)),
      timeoutMs,
    );
    if (signal) {
      onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Browser session aborted'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    return await Promise.race([task, tripped]);
  } catch (error) {
    if (current === browser) {
      // Not closeBrowser: a session that blew its ceiling is by definition one
      // whose browser is not answering, and close() waits on the same protocol.
      forgetBrowser();
      await destroyBrowser(current);
    }
    await task.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    task.catch(() => {});
  }
}

// Nothing is kept warm on purpose. The extractor already closes each page as soon
// as it has read it, so what a long-lived browser holds is Chromium's own
// footprint — and because sessions run through launch() rather than
// launchPersistentContext(), keeping it alive preserves no cookies, storage or
// stealth profile. It buys a second of startup and costs a few hundred megabytes,
// so it goes as soon as the work does.
function scheduleIdleReap() {
  cancelIdleReap();
  if (!browser) return;
  const ttlMs = env('FREDY_BROWSER_IDLE_TTL_MS');
  if (!(ttlMs > 0)) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void reapIdleBrowser();
  }, ttlMs);
  idleTimer.unref?.();
}

function cancelIdleReap() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

async function reapIdleBrowser() {
  // Through the lock: it is free exactly when no operation holds the browser, so
  // acquiring it is what makes closing safe.
  let release;
  try {
    release = await lock.acquire(env('FREDY_BROWSER_LOCK_TIMEOUT_MS'));
  } catch {
    return; // Busy again — the next session's finally will reschedule us.
  }
  try {
    const current = browser;
    if (!current) return;
    forgetBrowser();
    logger.debug('Closing the idle browser.');
    await closeBrowser(current);
  } catch (error) {
    logger.warn('Idle browser reap failed', error);
  } finally {
    release();
  }
}

function forgetBrowser() {
  browser = null;
  browserProxy = null;
  sessionsSinceLaunch = 0;
}
