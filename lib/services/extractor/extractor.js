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

  // Discovery returns { listings, containerPresent }; the non-browser path
  // still returns raw markup that has to be parsed here.
  parseResponseText = (crawlContainer, crawlFields, url) => {
    if (this.responseText && Array.isArray(this.responseText.listings)) return this.responseText;
    return { listings: parse(crawlContainer, crawlFields, this.responseText, url) ?? [], containerPresent: true };
  };
}
