/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { closeBrowser, launchBrowser } from './puppeteerExtractor.js';
import logger from '../logger.js';

let browser = null;
let browserProxy = null;
let lockTail = Promise.resolve();

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
      try {
        browser = await launchBrowser(url, proxyUrl ? { proxyUrl } : {});
      } catch (error) {
        logger.event('browser_launch_failure', 'error', 'Failed to launch the browser process.', error);
        throw error;
      }
      browserProxy = proxyUrl;
    }
    return await operation(browser);
  } finally {
    release();
  }
}

export async function resetBrowserSession() {
  const current = browser;
  browser = null;
  browserProxy = null;
  if (current) await closeBrowser(current);
}
