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
    rootSelectors: ['#main_column', 'main', 'body'],
    embeddedSelectors: [],
    gallerySelectors: ['#gallery_slides .sp-slide img', '#gallery_slides .sp-slide [style*="background-image"]'],
    imageUrlFilter: (url) => /wg-gesucht|wggesucht/i.test(url),
  });
}
function normalize(o) {
  const id = buildHash(o.id, o.price);
  const link = `https://www.wg-gesucht.de${o.link}`;
  const image = o.image != null ? o.image.replace('small', 'large') : null;
  const [rooms, city, road] = o.details?.split(' | ') || [];
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
  url: null,
  crawlContainer: '#main_column .wgg_card',
  pagination: { urlForPage: (url, page) => queryPage(url, page), maxPages: 3 },
  sortByDateParam: 'sort_column=0&sort_order=0',
  waitForSelector: 'body',
  crawlFields: {
    id: '@data-id',
    details: '.row .noprint .col-xs-11 |removeNewline |trim',
    price: '.middle .col-xs-3 |removeNewline |trim',
    size: '.middle .text-right |removeNewline |trim',
    rooms: '.middle .text-right |removeNewline |trim',
    title: '.truncate_title a |removeNewline |trim',
    link: '.truncate_title a@href',
    image: '.img-responsive@src',
    description: '.row .noprint .col-xs-11 |removeNewline |trim',
  },
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  normalize: normalize,
  captureDetails,
};
export const init = (sourceConfig) => {
  config.enabled = sourceConfig.enabled;
  config.url = sourceConfig.url;
};
export const metaInformation = {
  name: 'Wg gesucht',
  baseUrl: 'https://www.wg-gesucht.de/',
  id: 'wgGesucht',
};
export { config };
