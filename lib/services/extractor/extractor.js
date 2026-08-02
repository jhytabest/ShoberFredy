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

  /**
   * if you are extracting data from a SPA, you must provide a selector, otherwise
   * your response will never contain what you are really looking for
   * @param url
   * @param waitForSelector
   * @param jobKey
   */
  execute = async (url, waitForSelector = null, jobKey = null, discoverySchema = null) => {
    this.responseText = null;
    // `throwOnFailure` so a challenge stays a challenge. The extractor already
    // builds the right typed error — ProviderChallengeError, ProviderTimeoutError
    // — and this catch was the single point that flattened all of them into a
    // logged line and a null body. Discovery then reported "no cards discovered"
    // for every cause alike, so provider health could not tell a changed selector
    // from an IP block.
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
