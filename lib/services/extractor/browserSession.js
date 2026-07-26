/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { closeBrowser, launchBrowser } from './puppeteerExtractor.js';

let browser = null;
let browserProxy = null;
let lockTail = Promise.resolve();

/**
 * Run one browser operation at a time on a shared Chromium session. The
 * homeserver has two CPU cores and CloakBrowser's free tier supports one
 * concurrent session; serializing page work avoids swap-heavy startup bursts
 * without coupling this policy to a provider.
 */
export async function withBrowserSession(url, options, operation) {
  const previous = lockTail;
  let release;
  lockTail = new Promise((resolve) => {
    release = resolve;
  });
  await previous;

  try {
    const proxyUrl = typeof options?.proxyUrl === 'string' ? options.proxyUrl.trim() : '';
    if (browser && (!browser.connected || browserProxy !== proxyUrl)) {
      await closeBrowser(browser);
      browser = null;
    }
    if (!browser) {
      browser = await launchBrowser(url, proxyUrl ? { proxyUrl } : {});
      browserProxy = proxyUrl;
    }
    return await operation(browser);
  } finally {
    release();
  }
}

/**
 * Tear down the shared session so a caller that gave up on a hung operation
 * cannot leave the lock held forever.
 *
 * The lock is only released when its operation settles, so an operation that
 * never returns blocks every later browser user even after its own caller has
 * timed out. Closing the browser makes the pending CDP promises reject, which
 * lets that operation settle and the lock release. Safe to call from a timed
 * out caller precisely because {@link withBrowserSession} serializes: if one
 * operation is stuck, no other is using the browser.
 *
 * @returns {Promise<void>}
 */
export async function resetBrowserSession() {
  const current = browser;
  browser = null;
  browserProxy = null;
  if (current) await closeBrowser(current);
}
