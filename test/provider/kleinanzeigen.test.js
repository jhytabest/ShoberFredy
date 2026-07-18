/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { capturedQueue, mockFredy, providerConfig } from '../utils.js';
import * as provider from '../../lib/provider/kleinanzeigen.js';
import { closeBrowser, launchBrowser } from '../../lib/services/extractor/puppeteerExtractor.js';

describe('Kleinanzeigen capture producer', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser(providerConfig.kleinanzeigen.url);
  }, 180_000);
  afterAll(async () => closeBrowser(browser));
  beforeEach(() => capturedQueue.splice(0));

  it('captures the full viewad and listing gallery before enqueue', async () => {
    provider.init(providerConfig.kleinanzeigen, [], []);
    const Fredy = await mockFredy();
    const fredy = new Fredy(
      provider.config,
      { id: 'kleinanzeigen', notificationAdapter: [], spatialFilter: null, specFilter: null },
      provider.metaInformation.id,
      similarityCache,
      browser,
    );
    expect(await fredy.execute()).toHaveLength(1);
    const capture = capturedQueue[0].capture;
    expect(capture.fullText.length).toBeGreaterThan(300);
    expect(capture.images.length).toBeGreaterThan(0);
    expect(capture.images.every((image) => image.originalUrl.includes('img.kleinanzeigen.de'))).toBe(true);
  }, 180_000);
});
