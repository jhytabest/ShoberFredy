/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'fs';
import { describe, expect, it } from 'vitest';
import { captureHtmlString } from '../../lib/services/pipeline/htmlCapture.js';

describe('saved detail-page capture', () => {
  it('captures complete Immowelt text, embedded data, and gallery', () => {
    const html = readSample('immowelt', 'test/testFixtures/immowelt_detail.html');
    const capture = captureHtmlString({ id: 'iw', link: 'https://www.immowelt.de/expose/iw' }, html, {
      provider: 'immowelt',
      rootSelectors: ['main', 'body'],
      embeddedSelectors: ['#__UFRN_LIFECYCLE_SERVERREQUEST__', '#__NEXT_DATA__'],
      gallerySelectors: ['main img[src*="mms.immowelt.de"]'],
      imageUrlFilter: (url) => url.includes('mms.immowelt.de'),
      scanHtmlImages: true,
    });
    expect(capture.fullText.length).toBeGreaterThan(300);
    expect(capture.embeddedData.length).toBeGreaterThan(0);
    expect(capture.images.length).toBeGreaterThan(0);
  });

  it('captures WG-Gesucht gallery order and full listing body', () => {
    const html = readSample('wggesucht', 'test/testFixtures/wgGesucht_detail.html');
    const capture = captureHtmlString({ id: 'wg', link: 'https://www.wg-gesucht.de/wg.1.html' }, html, {
      provider: 'wgGesucht',
      rootSelectors: ['#main_column', 'main', 'body'],
      gallerySelectors: ['#gallery_slides .sp-slide img'],
      imageUrlFilter: (url) => /wg-gesucht|wggesucht/i.test(url),
    });
    expect(capture.fullText.length).toBeGreaterThan(300);
    expect(capture.images.length).toBeGreaterThan(0);
    expect(capture.images.map((image) => image.position)).toEqual(capture.images.map((_, index) => index));
  });

  it('restricts Kleinanzeigen media to the listing gallery', () => {
    const html = readSample('kleinanzeigen', 'test/testFixtures/kleinanzeigen_detail.html');
    const capture = captureHtmlString({ id: 'ka', link: 'https://www.kleinanzeigen.de/s-anzeige/1' }, html, {
      provider: 'kleinanzeigen',
      rootSelectors: ['#viewad-main', 'main', 'body'],
      gallerySelectors: ['.galleryimage-element img', '.galleryimage-element [style*="background-image"]'],
      imageUrlFilter: (url) => url.includes('img.kleinanzeigen.de'),
    });
    expect(capture.fullText.length).toBeGreaterThan(300);
    expect(capture.images.length).toBeGreaterThan(0);
    expect(capture.images.every((image) => image.originalUrl.includes('img.kleinanzeigen.de'))).toBe(true);
  });
});

function readSample(name, fallback) {
  const supplied = `htmls/${name}`;
  return fs.readFileSync(fs.existsSync(supplied) ? supplied : fallback, 'utf8');
}
