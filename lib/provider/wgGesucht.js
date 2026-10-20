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
    name: 'wgGesucht_details',
    waitForSelector: '#basic_ad_details',
    rootSelectors: ['#basic_ad_details', '#main_column'],
    detailRoot: '#basic_ad_details',
    embeddedSelectors: [],
    gallerySelectors: ['#gallery_slides .sp-slide img', '#gallery_slides .sp-slide [style*="background-image"]'],
    imageUrlFilter: (url) => /wg-gesucht|wggesucht/i.test(url),
  });
}
function normalize(o) {
  const id = buildHash(o.id, o.price);
  const link = o.link ? new URL(o.link, metaInformation.baseUrl).href : null;
  const image = o.image != null ? o.image.replace('small', 'large') : null;
  const [rooms, city, road] = o.details?.split(/\s*[|·]\s*/) || [];
  const address = [city, road].filter(Boolean).join(', ') || null;
  return {
    id,
    externalId: String(o.id),
    link,
    title: o.title || '',
    price: extractNumber(o.price),
    size: extractNumber(o.size),
    rooms: extractNumber(rooms),
    address,
    image,
    description: o.description,
  };
}

const config = {
  crawlContainer: '#main_column a.wgg-list-card.offer_list_item[data-id][href]',
  emptyResultSelector: '#main_column h2.mb10',
  emptyResultPattern: '^0\\s+(?:Wohnungen|WG-Zimmer|1-Zimmer-Wohnungen|Häuser)\\b',
  pagination: { urlForPage: (url, page) => queryPage(url, page), maxPages: 3 },
  sortByDateParam: 'sort_column=0&sort_order=0',
  waitForSelector: 'body',
  crawlFields: {
    id: '@data-id',
    details: '.ad-subtitle |removeNewline |trim',
    price: '.price-row .card-main-text |removeNewline |trim',
    size: '.size-value |removeNewline |trim',
    title: '.ad-title |removeNewline |trim',
    link: '@href',
    image: '.top-image-card@src',
    description: '.ad-subtitle |removeNewline |trim',
  },
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  normalize: normalize,
  captureDetails,
};
// A pure builder: each call gets its own config carrying that job's url, so
// two jobs on this portal discovering concurrently never see each other's
// search — there is no shared mutable `config.url` to race on.
export const init = (sourceConfig) => ({ ...config, url: sourceConfig.url });
export const metaInformation = {
  name: 'Wg gesucht',
  baseUrl: 'https://www.wg-gesucht.de/',
  id: 'wgGesucht',
};
export { config };
