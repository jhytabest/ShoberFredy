/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as cheerio from 'cheerio';
import { Worker } from 'node:worker_threads';
import logger from '../../logger.js';

const DEFAULT_PARSE_TIMEOUT_MS = 30_000;

/** Parse rendered discovery HTML away from the API/listing-worker event loop. */
export function parseInWorker(crawlContainer, crawlFields, text, url) {
  if (!text) return Promise.resolve(null);
  const timeoutMs = positiveIntEnv('FREDY_DISCOVERY_PARSE_TIMEOUT_MS', DEFAULT_PARSE_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parserWorkerThread.js', import.meta.url), {
      workerData: { crawlContainer, crawlFields, text, url },
    });
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      void worker.terminate();
      reject(new Error(`Discovery HTML parsing exceeded ${timeoutMs}ms for ${url}`));
    }, timeoutMs);

    worker.once('message', (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      if (message?.error) reject(new Error(message.error));
      else resolve(message?.result ?? null);
    });
    worker.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      if (settled || code === 0) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Discovery HTML parser worker exited with code ${code}`));
    });
  });
}

export function parse(crawlContainer, crawlFields, text, url) {
  if (!text) {
    logger.debug('No content found for ', url);
    return null;
  }

  if (!crawlContainer || !crawlFields) {
    logger.debug('Cannot parse, selector was empty for url ', url);
    return null;
  }

  const $ = cheerio.load(text);
  const result = [];

  if ($(crawlContainer).length === 0) {
    logger.debug('No elements in crawl container found for url ', url);
    return null;
  }

  $(crawlContainer).each((_, element) => {
    const container = $(element);
    const parsedObject = {};

    // Parse fields based on crawlFields
    for (const [key, fieldSelector] of Object.entries(crawlFields)) {
      let value;

      try {
        const selector = fieldSelector.includes('|')
          ? fieldSelector.substring(0, fieldSelector.indexOf('|')).trim()
          : fieldSelector;

        if (selector.includes('@')) {
          const [sel, attr] = selector.split('@');
          if (sel.length === 0) {
            value = container.attr(attr.trim());
          } else {
            value = container.find(sel.trim()).attr(attr.trim());
          }
        } else {
          value = container.find(selector.trim()).text();
        }

        // Apply modifiers if specified
        if (fieldSelector.includes('|')) {
          /* eslint-disable no-unused-vars */
          const [_, ...modifiers] = fieldSelector.split('|').map((s) => s.trim());
          /* eslint-enable no-unused-vars */
          value = applyModifiers(value, modifiers);
        }

        parsedObject[key] = value || null;
      } catch (error) {
        logger.error(`Error parsing field '${key}' with selector '${fieldSelector}':`, error);
        parsedObject[key] = null;
      }
    }

    if (parsedObject.id != null) {
      result.push(parsedObject);
    } else {
      logger.debug('ID not found. Not relaying object.');
    }
  });

  return result;
}

function positiveIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Helper function to apply modifiers
function applyModifiers(value, modifiers) {
  if (!value) return value;

  modifiers.forEach((modifier) => {
    switch (modifier) {
      case 'int':
        value = parseInt(value, 10);
        break;
      case 'trim':
        value = value.replace(/\s+/g, ' ').trim();
        break;
      case 'removeNewline':
        value = value.replace(/\n/g, ' ');
        break;
      default:
        logger.warn(`Unknown modifier: ${modifier}`);
    }
  });

  return value;
}
