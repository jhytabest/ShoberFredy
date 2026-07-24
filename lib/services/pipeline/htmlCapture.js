/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import puppeteerExtractor from '../extractor/puppeteerExtractor.js';

export async function captureHtmlListing(listing, browser, options) {
  const extracted = await puppeteerExtractor(listing.link, null, {
    browser,
    name: options.name,
    provider: options.provider,
    throwOnFailure: true,
    detailSchema: {
      rootSelectors: options.rootSelectors || ['main', 'body'],
      embeddedSelectors: options.embeddedSelectors || [],
      gallerySelectors: options.gallerySelectors || [],
      scanHtmlImages: options.scanHtmlImages === true,
    },
    ...(options.puppeteerOptions || {}),
  });
  if (!extracted?.fullText) throw new Error(`Could not capture detail page for ${listing.link}`);
  return {
    provider: options.provider,
    externalId: options.externalId?.(listing) ?? listing.id,
    sourceUrl: listing.link,
    discoveredAt: listing.discoveredAt ?? Date.now(),
    discoveryData: { ...listing },
    fullText: extracted.fullText,
    embeddedData: extracted.embeddedData || [],
    images: filterExtractedImages(extracted.images || [], options.imageUrlFilter),
  };
}

function normalizeUrl(value) {
  if (!value || typeof value !== 'string') return null;
  const url = value.replace(/&amp;/g, '&').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

function filterExtractedImages(images, urlFilter) {
  const seen = new Set();
  const result = [];
  for (const image of images) {
    const originalUrl = normalizeUrl(image?.originalUrl);
    if (!originalUrl || seen.has(originalUrl) || (urlFilter && !urlFilter(originalUrl))) continue;
    seen.add(originalUrl);
    result.push({ position: result.length, kind: image?.kind || 'photo', originalUrl });
  }
  return result;
}
