/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { launch } from 'cloakbrowser/puppeteer';
import { botDetected } from './utils.js';
import { getPreLaunchConfig } from './botPrevention.js';
import logger from '../logger.js';
import { ProviderChallengeError, ProviderTimeoutError, ProviderTransientError } from '../pipeline/providerErrors.js';

const CHALLENGE_STATUS_CODES = new Set([403, 429]);

export async function launchBrowser(url, options) {
  const preCfg = getPreLaunchConfig(options || {});

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--ignore-certificate-errors',
    '--no-zygote',
    preCfg.windowSizeArg,
  ];

  return await launch({
    headless: true,
    humanize: true,
    args,
    locale: preCfg.langForFlag,
    ...(options?.proxyUrl ? { proxy: options.proxyUrl } : {}),
    ...(preCfg.timezone ? { timezone: preCfg.timezone } : {}),
  });
}

export async function closeBrowser(browser) {
  if (!browser) return;
  try {
    await browser.close();
  } catch {
    // ignore
  }
}

export default async function execute(url, waitForSelector, options) {
  let browser = options?.browser;
  let isExternalBrowser = !!browser;
  let page;
  let result;
  let failure = null;
  try {
    if (!isExternalBrowser) {
      browser = await launchBrowser(url, options);
    }

    page = await browser.newPage();

    if (Array.isArray(options?.cookies) && options.cookies.length > 0) {
      await page.setCookie(...options.cookies);
    }

    if (options?.preNavigateUrl) {
      try {
        await page.goto(options.preNavigateUrl, {
          waitUntil: 'domcontentloaded',
          timeout: options?.preNavigateTimeout ?? 12_000,
        });
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
      } catch {
        // ignore
      }
    }

    const response = await page.goto(url, {
      waitUntil: options?.waitUntil || 'domcontentloaded',
      timeout: options?.puppeteerTimeout || 60000,
    });

    const statusCode = response?.status?.() ?? 200;

    const challengedByStatus = CHALLENGE_STATUS_CODES.has(statusCode);
    if (challengedByStatus) {
      logger.warn(`Provider answered HTTP ${statusCode} (bot challenge), skipping page waits. Url: ${url}`);
    } else {
      if (options?.waitForNetworkIdle) {
        try {
          await page.waitForNetworkIdle({ timeout: options?.waitForNetworkIdleTimeout ?? 60_000 });
        } catch {
          // ignore — we proceed with whatever the DOM contains at this point
        }
      }
    }

    const discoverySchema = options?.discoverySchema;
    const detailSchema = options?.detailSchema;
    let pageSource = null;
    let botProbe = null;
    if (!challengedByStatus) {
      if (waitForSelector != null) {
        const selectorTimeout = options?.puppeteerSelectorTimeout ?? options?.puppeteerTimeout ?? 30_000;
        await page.waitForSelector(waitForSelector, { timeout: selectorTimeout });
      }
      if (discoverySchema || detailSchema) {
        botProbe = await page.evaluate(() => `${document.title}\n${document.body?.innerText || ''}`.slice(0, 100_000));
      } else if (waitForSelector != null) {
        pageSource = await page.evaluate((selector) => {
          const el = document.querySelector(selector);
          return el ? el.innerHTML : '';
        }, waitForSelector);
      } else {
        pageSource = await page.content();
      }
    }

    if (challengedByStatus || botDetected(botProbe ?? pageSource, statusCode)) {
      logger.event('bot_detection', 'warn', `Provider returned a bot-detection challenge. Url: ${url}`);

      result = null;
      if (options?.throwOnFailure) {
        failure = new ProviderChallengeError(`Provider returned a bot-detection challenge for ${url}`, {
          status: statusCode,
        });
      }
    } else if (discoverySchema) {
      result = await page.evaluate(extractDiscoveryListings, discoverySchema);
    } else if (detailSchema) {
      result = await page.evaluate(extractDetailListing, detailSchema);
    } else {
      result = pageSource || (await page.content());
    }
  } catch (error) {
    if (error?.name?.includes('Timeout')) {
      logger.debug('Error executing with CloakBrowser executor', error);
    } else {
      logger.warn('Error executing with CloakBrowser executor', error);
    }
    result = null;
    if (options?.throwOnFailure) {
      failure =
        error?.code === 'PROVIDER_ERROR'
          ? error
          : error?.name?.includes('Timeout')
            ? new ProviderTimeoutError(`Browser request timed out for ${url}`, { cause: error })
            : new ProviderTransientError(`Browser request failed for ${url}: ${error.message}`, { cause: error });
    }
  } finally {
    try {
      if (page) {
        await page.close();
      }
    } catch {
      // ignore
    }
    if (browser != null && !isExternalBrowser) {
      await closeBrowser(browser);
    }
  }
  if (options?.throwOnFailure && !result) {
    throw failure || new ProviderTransientError(`Browser returned no usable response for ${url}`);
  }
  return result;
}

function extractDiscoveryListings({ crawlContainer, crawlFields }) {
  if (!crawlContainer || !crawlFields) return [];
  const result = [];
  for (const element of document.querySelectorAll(crawlContainer)) {
    const parsedObject = {};
    for (const [key, fieldSelector] of Object.entries(crawlFields)) {
      const parts = fieldSelector.split('|').map((part) => part.trim());
      const selector = parts.shift();
      const attributeAt = selector.indexOf('@');
      let value;
      if (attributeAt >= 0) {
        const elementSelector = selector.slice(0, attributeAt).trim();
        const attribute = selector.slice(attributeAt + 1).trim();
        const selected = elementSelector ? element.querySelector(elementSelector) : element;
        value = selected?.getAttribute(attribute);
      } else {
        value = [...element.querySelectorAll(selector)].map((selected) => selected.textContent || '').join('');
      }
      for (const modifier of parts) {
        if (!value) break;
        if (modifier === 'int') value = Number.parseInt(value, 10);
        else if (modifier === 'trim') value = value.replace(/\s+/g, ' ').trim();
        else if (modifier === 'removeNewline') value = value.replace(/\n/g, ' ');
      }
      parsedObject[key] = value || null;
    }
    if (parsedObject.id != null) result.push(parsedObject);
  }
  return result;
}

function extractDetailListing({ rootSelectors, embeddedSelectors, gallerySelectors, scanHtmlImages }) {
  const cleanMultiline = (value) =>
    String(value || '')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.replace(/[\t ]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  const escapeJsonControls = (text) =>
    // eslint-disable-next-line no-control-regex
    text.replace(/[\u0000-\u001f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const parseJsonScript = (raw) => {
    if (!raw) return null;
    const value = raw.trim();
    try {
      return JSON.parse(value);
    } catch {
      // Continue with the Immowelt JSON.parse('...') wrapper below.
    }
    const match = value.match(/JSON\.parse\(\s*(["'])((?:\\.|[^\\])*?)\1\s*,?\s*\)/s);
    if (!match) return null;
    const [, quote, inner] = match;
    try {
      return quote === "'"
        ? JSON.parse(escapeJsonControls(inner.replace(/\\'/g, "'")))
        : JSON.parse(JSON.parse(escapeJsonControls(`"${inner}"`)));
    } catch {
      return null;
    }
  };

  let fullText = '';
  for (const selector of rootSelectors) {
    for (const element of document.querySelectorAll(selector)) {
      const text = cleanMultiline(element.innerText);
      if (text.length > fullText.length) fullText = text;
    }
    if (fullText.length > 300) break;
  }

  const embeddedData = [];
  for (const element of document.querySelectorAll('script[type="application/ld+json"]')) {
    const value = parseJsonScript(element.textContent);
    if (value != null) embeddedData.push({ kind: 'json-ld', value });
  }
  for (const selector of embeddedSelectors) {
    for (const element of document.querySelectorAll(selector)) {
      const value = parseJsonScript(element.innerHTML || element.textContent);
      if (value != null) embeddedData.push({ kind: selector, value });
    }
  }

  const seen = new Set();
  const images = [];
  const addImage = (value, kind = 'photo') => {
    if (!value || typeof value !== 'string') return;
    const originalUrl = value.replace(/&amp;/g, '&').trim();
    if (!/^https?:\/\//i.test(originalUrl) || seen.has(originalUrl)) return;
    seen.add(originalUrl);
    images.push({ position: images.length, kind, originalUrl });
  };
  for (const selector of gallerySelectors) {
    for (const element of document.querySelectorAll(selector)) {
      for (const attribute of ['data-imgsrc', 'data-src', 'data-lazy-src', 'src', 'href']) {
        addImage(element.getAttribute(attribute));
      }
      const srcset = element.getAttribute('srcset');
      if (srcset) addImage(srcset.split(',').at(-1)?.trim().split(/\s+/)[0]);
      const background = (element.getAttribute('style') || '').match(/url\(['"]?([^'")]+)['"]?\)/i)?.[1];
      addImage(background);
    }
  }
  if (scanHtmlImages) {
    const html = document.documentElement.innerHTML.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    for (const match of html.matchAll(/https?:\/\/[^"'\\\s<>]+/gi)) addImage(match[0]);
  }

  return { fullText, embeddedData, images };
}
