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
    // Immowelt wraps its payload in window[...] = JSON.parse('...') (single
    // quotes, trailing comma) or JSON.parse("...") (double quotes).
  }
  const match = value.match(/JSON\.parse\(\s*(["'])((?:\\.|[^\\])*?)\1\s*,?\s*\)/s);
  if (match) {
    const [, quote, inner] = match;
    try {
      // In a single-quoted JS literal the double quotes are unescaped, so the
      // body is already a JSON document (only the JS-only \' needs undoing). In
      // a double-quoted literal the body is a JSON string that decodes to the
      // document (the original double-parse). Raw control characters are legal
      // in a JS string but not in JSON, so escape them first.
      return quote === "'"
        ? JSON.parse(escapeJsonControls(inner.replace(/\\'/g, "'")))
        : JSON.parse(JSON.parse(escapeJsonControls(`"${inner}"`)));
    } catch {
      return null;
    }
  }
  return null;
}

function escapeJsonControls(text) {
  // Raw control characters are valid inside a JS string literal but not
  // inside JSON, so escape them before re-parsing the extracted payload.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
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
