/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { buildHash } from '../utils.js';
import { extractNumber } from '../utils/extract-number.js';
import { captureHtmlListing } from '../services/pipeline/htmlCapture.js';
import { kleinanzeigenPage } from '../services/extractor/pagination.js';

function toAbsoluteLink(link) {
  if (!link) return null;
  return link.startsWith('http') ? link : `https://www.kleinanzeigen.de${link}`;
}

async function captureDetails(listing, browser) {
  return await captureHtmlListing({ ...listing, link: toAbsoluteLink(listing.link) }, browser, {
    provider: metaInformation.id,
    name: 'kleinanzeigen_details',
    rootSelectors: ['#viewad-main', 'main', 'body'],
    embeddedSelectors: [],
    gallerySelectors: [
      '.galleryimage-element img',
      '.galleryimage-element [style*="background-image"]',
      '.vip-image-gallery img',
    ],
    imageUrlFilter: (url) => url.includes('img.kleinanzeigen.de'),
  });
}

function firstMatch(text, pattern) {
  const match = String(text || '').match(pattern);
  return match ? match[1] : null;
}

function normalize(o) {
  const facts = o.facts || '';
  const tags = o.tags || facts;
  const size = extractNumber(firstMatch(tags, /(\d[\d.,]*)\s*m²/u));
  const rooms = extractNumber(firstMatch(tags, /(\d[\d.,]*)\s*Zi\./iu));
  const price = extractNumber(o.price) ?? extractNumber(firstMatch(facts, /(\d[\d.,]*)\s*€/u));
  const address = firstMatch(o.address, /(\d{5}\s+\p{Lu}\p{Ll}+(?:[- ]\p{Lu}\p{Ll}+)*)/u) || o.address;

  return {
    id: buildHash(o.id, price),
    externalId: String(o.id),
    title: o.title,
    link: toAbsoluteLink(o.link) || o.link,
    price,
    size,
    rooms,
    address: address ? String(address).trim() : null,
    description: o.description || facts || null,
    image: o.image,
  };
}

const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  crawlContainer: '#srchrslt-adtable article[data-adid]',
  pagination: { urlForPage: kleinanzeigenPage, maxPages: 3 },
  sortByDateParam: null,
  waitForSelector: 'body',
  crawlFields: {
    id: '@data-adid',
    link: '@data-href',
    title: 'h2 a, h3 a | removeNewline | trim',
    price: '.aditem-main--middle--price-shipping--price, p.text-secondary | removeNewline | trim',
    tags: '.aditem-main--middle--tags | removeNewline | trim',
    description: '.aditem-main .aditem-main--middle--description | removeNewline | trim',
    address: '.aditem-main--top--left, span | removeNewline | trim',
    facts: 'p | removeNewline | trim',
    image: 'img@src',
  },
  captureDetails,
  normalize: normalize,
};
export const metaInformation = {
  name: 'Kleinanzeigen',
  baseUrl: 'https://www.kleinanzeigen.de/',
  id: 'kleinanzeigen',
};
// A pure builder: each call gets its own config carrying that job's url, so
// two jobs on this portal discovering concurrently never see each other's
// search — there is no shared mutable `config.url` to race on.
export const init = (sourceConfig) => ({ ...config, url: sourceConfig.url });
export { config };
