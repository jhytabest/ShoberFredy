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
