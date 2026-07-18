/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, describe, expect, it } from 'vitest';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { capturedQueue, mockFredy, providerConfig } from '../utils.js';
import * as provider from '../../lib/provider/immoscout.js';

describe('ImmoScout capture producer', () => {
  beforeEach(() => capturedQueue.splice(0));

  it('captures the expose API payload, complete text, and media before enqueue', async () => {
    provider.init(providerConfig.immoscout, [], []);
    const Fredy = await mockFredy();
    const fredy = new Fredy(
      provider.config,
      { id: 'immoscout', notificationAdapter: [], spatialFilter: null, specFilter: null },
      provider.metaInformation.id,
      similarityCache,
      undefined,
    );
    const queued = await fredy.execute();
    expect(queued).toHaveLength(1);
    expect(capturedQueue).toHaveLength(1);
    expect(capturedQueue[0].capture.fullText.length).toBeGreaterThan(100);
    expect(capturedQueue[0].capture.embeddedData[0].kind).toBe('immoscout-expose');
    expect(capturedQueue[0].capture.images.length).toBeGreaterThan(0);
  }, 120_000);
});
