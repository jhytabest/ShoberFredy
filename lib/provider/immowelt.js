/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { buildHash } from '../utils.js';
import { extractNumber } from '../utils/extract-number.js';
import { captureHtmlListing } from '../services/pipeline/htmlCapture.js';
import { convertSearchUrlToRequest } from '../services/immowelt/immowelt-search-model.js';
import { searchClassifieds, releaseSession } from '../services/immowelt/immoweltBff.js';
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

function readFact(classified, type) {
  const fact = classified?.hardFacts?.facts?.find((entry) => entry?.type === type);
  return fact?.splitValue ?? fact?.value ?? null;
}

function normalize(o) {
  const externalId = immoweltOfferId(o.url) || String(o.id || '');
  const price = o.hardFacts?.price?.value ?? null;
  const address = o.location?.address ?? {};
  const street = [address.street, address.houseNumber].filter(Boolean).join(' ');
  const locality = [address.zipCode, address.district || address.city].filter(Boolean).join(' ');
  const city = o.tracking?.city;
  return {
    id: buildHash(externalId, price),
    externalId,
    link: o.url ? new URL(o.url, metaInformation.baseUrl).href : null,
    title: (o.mainDescription?.headline || o.hardFacts?.title || '').trim(),
    price: extractNumber(price),
    size: extractNumber(readFact(o, 'livingSpace') ?? o.rawData?.surface?.main),
    rooms: extractNumber(readFact(o, 'numberOfRooms') ?? o.rawData?.nbroom),
    address: [street, locality, city && city !== address.city && city !== address.district ? city : null]
      .filter(Boolean)
      .join(', '),
    image: o.gallery?.images?.[0]?.url ?? null,
    description: o.mainDescription?.description ?? null,
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
  getListings: (url, browser) => searchClassifieds(browser, convertSearchUrlToRequest(url)),
  discoveryNeedsBrowser: true,
  releaseDiscovery: releaseSession,
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
};
export { config };
