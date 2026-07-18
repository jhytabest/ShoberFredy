/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { MAX_IMAGE_BYTES, optimizeImageBuffer } from '../../lib/services/pipeline/imageOptimizer.js';

describe('listing image optimizer', () => {
  it.each([
    ['landscape', 2400, 1600],
    ['portrait', 1200, 2600],
    ['floorplan-like', 3000, 2200],
    ['transparent', 1600, 1600],
  ])('writes %s input as WebP below the hard byte cap', async (_name, width, height) => {
    const source = await sharp({
      create: { width, height, channels: 4, background: { r: 220, g: 180, b: 130, alpha: 0.7 } },
    })
      .png()
      .toBuffer();
    const output = await optimizeImageBuffer(source);
    expect(output.buffer.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect((await sharp(output.buffer).metadata()).format).toBe('webp');
  });
});
