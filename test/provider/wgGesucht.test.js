/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capturedQueue, mockFredy, providerConfig } from '../utils.js';
import * as provider from '../../lib/provider/wgGesucht.js';
import { closeBrowser, launchBrowser } from '../../lib/services/extractor/puppeteerExtractor.js';

describe('WG-Gesucht capture producer', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser(providerConfig.wgGesucht.url);
  }, 120_000);
  afterAll(async () => closeBrowser(browser));
  beforeEach(() => capturedQueue.splice(0));

  it('captures complete listing text and ordered gallery before enqueue', async () => {
    provider.init(providerConfig.wgGesucht, [], []);
    const Fredy = await mockFredy();
    const fredy = new Fredy(
      provider.config,
      { id: 'wgGesucht', notificationAdapter: [], spatialFilter: null, specFilter: null },
      provider.metaInformation.id,
      browser,
    );
    expect(await fredy.execute()).toHaveLength(1);
    const capture = capturedQueue[0].capture;
    expect(capture.fullText.length).toBeGreaterThan(300);
    expect(capture.images.map((image) => image.position)).toEqual(capture.images.map((_, index) => index));
  }, 120_000);
});
