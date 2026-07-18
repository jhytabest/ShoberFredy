/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as cheerio from 'cheerio';
import puppeteerExtractor from '../extractor/puppeteerExtractor.js';

export async function captureHtmlListing(listing, browser, options) {
  const html = await puppeteerExtractor(listing.link, null, {
    browser,
    name: options.name,
    ...(options.puppeteerOptions || {}),
  });
  if (!html) throw new Error(`Could not capture detail page for ${listing.link}`);
  return captureHtmlString(listing, html, options);
}

export function captureHtmlString(listing, html, options) {
  const $ = cheerio.load(html);
  $('script, style, noscript, template').each((_, element) => {
    if (!options.embeddedSelectors?.some((selector) => $(element).is(selector))) $(element).remove();
  });

  const fullText = bestText($, options.rootSelectors || ['main', 'body']);
  if (!fullText) throw new Error(`Captured detail page has no listing text for ${listing.link}`);

  const embeddedData = extractEmbeddedData(html, options.embeddedSelectors || []);
  const images = extractGalleryImages(
    html,
    options.gallerySelectors || [],
    options.imageUrlFilter,
    options.scanHtmlImages === true,
  );

  return {
    provider: options.provider,
    externalId: options.externalId?.(listing) ?? listing.id,
    sourceUrl: listing.link,
    discoveredAt: listing.discoveredAt ?? Date.now(),
    discoveryData: { ...listing },
    fullText,
    embeddedData,
    images,
  };
}

function bestText($, selectors) {
  let best = '';
  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const text = cleanMultiline($(element).text());
      if (text.length > best.length) best = text;
    });
    if (best.length > 300) break;
  }
  return best;
}

function extractEmbeddedData(html, selectors) {
  const $ = cheerio.load(html);
  const result = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    const parsed = parseJsonScript($(element).text());
    if (parsed != null) result.push({ kind: 'json-ld', value: parsed });
  });
  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const raw = $(element).html() || $(element).text();
      const parsed = parseJsonScript(raw);
      if (parsed != null) result.push({ kind: selector, value: parsed });
    });
  }
  return result;
}

function parseJsonScript(raw) {
  if (!raw) return null;
  const value = raw.trim();
  try {
    return JSON.parse(value);
  } catch {
    // Immowelt currently wraps its payload in window[...] = JSON.parse("...").
  }
  const match = value.match(/JSON\.parse\(("(?:\\.|[^"\\])*")\)/s);
  if (match) {
    try {
      return JSON.parse(JSON.parse(match[1]));
    } catch {
      return null;
    }
  }
  return null;
}

function extractGalleryImages(html, selectors, urlFilter, scanHtmlImages) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const images = [];
  const add = (url, kind = 'photo') => {
    const normalized = normalizeUrl(url);
    if (!normalized || seen.has(normalized) || (urlFilter && !urlFilter(normalized))) return;
    seen.add(normalized);
    images.push({ position: images.length, kind, originalUrl: normalized });
  };

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const node = $(element);
      for (const attr of ['data-imgsrc', 'data-src', 'data-lazy-src', 'src', 'href']) add(node.attr(attr));
      const srcset = node.attr('srcset');
      if (srcset) add(srcset.split(',').at(-1)?.trim().split(/\s+/)[0]);
      const style = node.attr('style') || '';
      const background = style.match(/url\(['"]?([^'")]+)['"]?\)/i)?.[1];
      add(background);
    });
  }
  if (scanHtmlImages) {
    const normalizedHtml = html.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    for (const match of normalizedHtml.matchAll(/https?:\/\/[^"'\\\s<>]+/gi)) add(match[0]);
  }
  return images;
}

function normalizeUrl(value) {
  if (!value || typeof value !== 'string') return null;
  const url = value.replace(/&amp;/g, '&').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

function cleanMultiline(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
