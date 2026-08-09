/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { buildHash } from '../utils.js';
import { extractNumber } from '../utils/extract-number.js';
import { captureHtmlListing } from '../services/pipeline/htmlCapture.js';
import { queryPage } from '../services/extractor/pagination.js';

async function captureDetails(listing, browser) {
  return await captureHtmlListing(listing, browser, {
    provider: metaInformation.id,
    name: 'immowelt_details',
    rootSelectors: ['main', 'body'],
    embeddedSelectors: ['#__UFRN_LIFECYCLE_SERVERREQUEST__', '#__NEXT_DATA__'],
    gallerySelectors: [
      '[data-testid*="gallery"] img',
      '[data-testid*="gallery"] [style*="background-image"]',
      'main img[src*="mms.immowelt.de"]',
    ],
    imageUrlFilter: (url) => url.includes('mms.immowelt.de'),
    scanHtmlImages: true,
    puppeteerOptions: config.puppeteerOptions,
  });
}

function normalize(o) {
  const externalId = immoweltOfferId(o.id) || immoweltOfferId(o.link) || String(o.id || o.link);
  const id = buildHash(externalId, o.price);
  return {
    id,
    externalId,
    link: o.link,
    title: o.title || '',
    price: extractNumber(o.price),
    size: extractNumber(o.size),
    rooms: extractNumber(o.rooms),
    address: o.address,
    image: o.image,
    description: o.description,
  };
}

function immoweltOfferId(value) {
  if (!value) return null;
  try {
    return new URL(value, metaInformation.baseUrl).pathname.match(/\/expose\/([a-z0-9-]{8,})(?:\/|$)/iu)?.[1] || null;
  } catch {
    return null;
  }
}

const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  crawlContainer:
    'div[data-testid="serp-core-scrollablelistview-testid"]:not(div[data-testid="serp-enlargementlist-testid"] div[data-testid="serp-card-testid"]) div[data-testid="serp-core-classified-card-testid"]',
  pagination: { urlForPage: (url, page) => queryPage(url, page), maxPages: 3 },
  sortByDateParam: 'order=DateDesc',
  waitForSelector: null,
  puppeteerOptions: {
    puppeteerTimeout: 30_000,
    preNavigateUrl: 'https://www.immowelt.de/',
    preNavigateTimeout: 12_000,
    waitForNetworkIdle: true,
    waitForNetworkIdleTimeout: 15_000,
  },
  crawlFields: {
    id: 'a@href',
    price: 'div[data-testid="cardmfe-price-testid"] | removeNewline | trim',
    size: 'div[data-testid="cardmfe-keyfacts-testid"] div:nth-of-type(3) | removeNewline | trim',
    rooms: 'div[data-testid="cardmfe-keyfacts-testid"] div:nth-of-type(1) | removeNewline | trim',
    title: 'div[data-testid="cardmfe-description-box-text-test-id"] > div:nth-of-type(2)',
    link: 'a@href',
    description: 'div[data-testid="cardmfe-description-text-test-id"] > div:nth-of-type(2) | removeNewline | trim',
    address: 'div[data-testid="cardmfe-description-box-address"] | removeNewline | trim',
    image: 'div[data-testid="cardmfe-picture-box-opacity-layer-test-id"] img@src',
  },
  normalize: normalize,
  captureDetails,
};
// A pure builder: each call gets its own config carrying that job's url, so
// two jobs on this portal discovering concurrently never see each other's
// search — there is no shared mutable `config.url` to race on.
export const init = (sourceConfig) => ({ ...config, url: sourceConfig.url });
export const metaInformation = {
  name: 'Immowelt',
  baseUrl: 'https://www.immowelt.de/',
  id: 'immowelt',
  requiresProxy: true,
};
export { config };
