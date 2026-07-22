/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { setDebug } from './utils.js';
import puppeteerExtractor from './puppeteerExtractor.js';
import { parse } from './parser/parser.js';
import logger from '../logger.js';

const DEFAULT_OPTIONS = {
  debug: false,
  puppeteerTimeout: 60_000,
  puppeteerHeadless: true,
};

export default class Extractor {
  constructor(options) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
    this.responseText = null;
    setDebug(this.options);
  }

  /**
   * if you are extracting data from a SPA, you must provide a selector, otherwise
   * your response will never contain what you are really looking for
   * @param url
   * @param waitForSelector
   * @param jobKey
   */
  execute = async (url, waitForSelector = null, jobKey = null, discoverySchema = null) => {
    this.responseText = null;
    try {
      this.responseText = await puppeteerExtractor(url, waitForSelector, {
        ...this.options,
        name: jobKey,
        discoverySchema,
      });
    } catch (error) {
      logger.error('Error trying to load page.', error);
    }
    return this;
  };

  parseResponseText = (crawlContainer, crawlFields, url) => {
    if (Array.isArray(this.responseText)) return this.responseText;
    return parse(crawlContainer, crawlFields, this.responseText, url);
  };
}
