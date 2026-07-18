/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capturedQueue, mockFredy, providerConfig } from '../utils.js';
import * as provider from '../../lib/provider/immowelt.js';
import { closeBrowser, launchBrowser } from '../../lib/services/extractor/puppeteerExtractor.js';

describe('Immowelt capture producer', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser(providerConfig.immowelt.url);
  }, 180_000);
  afterAll(async () => closeBrowser(browser));
  beforeEach(() => capturedQueue.splice(0));

  it('captures rendered text, lifecycle data, and the gallery before enqueue', async () => {
    provider.init(providerConfig.immowelt, [], []);
    const Fredy = await mockFredy();
    const fredy = new Fredy(
      provider.config,
      { id: 'immowelt', notificationAdapter: [], spatialFilter: null, specFilter: null },
      provider.metaInformation.id,
      browser,
    );
    expect(await fredy.execute()).toHaveLength(1);
    const capture = capturedQueue[0].capture;
    expect(capture.fullText.length).toBeGreaterThan(300);
    expect(capture.embeddedData.length).toBeGreaterThan(0);
    expect(capture.images.length).toBeGreaterThan(0);
  }, 180_000);
});
