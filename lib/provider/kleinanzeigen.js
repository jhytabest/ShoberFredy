/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { buildHash, isOneOf } from '../utils.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import { extractNumber } from '../utils/extract-number.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */
import { captureHtmlListing } from '../services/pipeline/htmlCapture.js';
import { kleinanzeigenPage } from '../services/extractor/pagination.js';

let appliedBlackList = [];
let appliedBlacklistedDistricts = [];

function toAbsoluteLink(link) {
  if (!link) return null;
  return link.startsWith('http') ? link : `https://www.kleinanzeigen.de${link}`;
}

function isListingActive(link) {
  return checkIfListingIsActive(link, [/Gelöscht/i, /Reserviert/i]);
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

/**
 * @param {any} o
 * @returns {ParsedListing}
 */
function normalize(o) {
  const parts = (o.tags || '').split('·').map((p) => p.trim());
  const size = parts.find((p) => p.includes('m²'));
  const rooms = parts.find((p) => p.includes('Zi.'));
  const id = buildHash(o.id, o.price);

  return {
    id,
    externalId: String(o.id),
    title: o.title,
    link: toAbsoluteLink(o.link) || o.link,
    price: extractNumber(o.price),
    size: extractNumber(size),
    rooms: extractNumber(rooms),
    address: o.address,
    description: o.description,
    image: o.image,
  };
}

/**
 * @param {ParsedListing} o
 * @returns {boolean}
 */
function applyBlacklist(o) {
  const titleNotBlacklisted = !isOneOf(o.title, appliedBlackList);
  const descNotBlacklisted = !isOneOf(o.description, appliedBlackList);
  const isBlacklistedDistrict =
    appliedBlacklistedDistricts.length === 0 ? false : isOneOf(o.description, appliedBlacklistedDistricts);
  return o.title != null && !isBlacklistedDistrict && titleNotBlacklisted && descNotBlacklisted;
}

/** @type {ProviderConfig} */
const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  url: null,
  crawlContainer: '#srchrslt-adtable .ad-listitem ',
  pagination: { urlForPage: kleinanzeigenPage, maxPages: 3 },
  //sort by date is standard oO
  sortByDateParam: null,
  waitForSelector: 'body',
  crawlFields: {
    id: '.aditem@data-adid',
    price: '.aditem-main--middle--price-shipping--price | removeNewline | trim',
    tags: '.aditem-main--middle--tags | removeNewline | trim',
    title: '.aditem-main .text-module-begin | removeNewline | trim',
    link: '.aditem@data-href',
    description: '.aditem-main .aditem-main--middle--description | removeNewline | trim',
    address: '.aditem-main--top--left | trim | removeNewline',
    image: 'img@src',
  },
  captureDetails,
  normalize: normalize,
  filter: applyBlacklist,
  activeTester: isListingActive,
};
export const metaInformation = {
  name: 'Kleinanzeigen',
  baseUrl: 'https://www.kleinanzeigen.de/',
  id: 'kleinanzeigen',
};
export const init = (sourceConfig, blacklist, blacklistedDistricts) => {
  config.enabled = sourceConfig.enabled;
  config.url = sourceConfig.url;
  appliedBlacklistedDistricts = blacklistedDistricts || [];
  appliedBlackList = blacklist || [];
};
export { config };
