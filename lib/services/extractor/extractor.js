/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import puppeteerExtractor from './puppeteerExtractor.js';
import { parse } from './parser/parser.js';

const DEFAULT_OPTIONS = {
  puppeteerTimeout: 60_000,
};

export default class Extractor {
  constructor(options) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
    this.responseText = null;
  }

  execute = async (url, waitForSelector = null, jobKey = null, discoverySchema = null) => {
    this.responseText = null;
    this.responseText = await puppeteerExtractor(url, waitForSelector, {
      ...this.options,
      name: jobKey,
      discoverySchema,
      throwOnFailure: true,
    });
    return this;
  };

  parseResponseText = (crawlContainer, crawlFields, url) => {
    if (Array.isArray(this.responseText)) return this.responseText;
    return parse(crawlContainer, crawlFields, this.responseText, url);
  };
}
