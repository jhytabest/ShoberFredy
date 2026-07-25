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
 * First capture group of a pattern, or null when it does not match.
 * @param {string|null|undefined} text
 * @param {RegExp} pattern
 * @returns {string|null}
 */
function firstMatch(text, pattern) {
  const match = String(text || '').match(pattern);
  return match ? match[1] : null;
}

/**
 * @param {any} o
 * @returns {ParsedListing}
 */
function normalize(o) {
  // `facts` is the concatenated card paragraphs and is the only source that
  // survives both card markups, so the per-class fields fall back to it.
  const facts = o.facts || '';
  const tags = o.tags || facts;
  const size = extractNumber(firstMatch(tags, /([\d.,]+)\s*m²/u));
  const rooms = extractNumber(firstMatch(tags, /([\d.,]+)\s*Zi\./iu));
  const price = extractNumber(o.price) ?? extractNumber(firstMatch(facts, /([\d.,]+)\s*€/u));
  // The location line carries the postcode and district. On the new markup it
  // shares a selector with the seller span and the texts are concatenated
  // without a separator ("13088 WeissenseePFR Holding GmbH"), so accept only
  // capitalised district words and stop at the first missing word boundary.
  const address = firstMatch(o.address, /(\d{5}\s+\p{Lu}\p{Ll}+(?:[- ]\p{Lu}\p{Ll}+)*)/u) || o.address;

  return {
    // Hash the parsed number rather than the raw price text: the two card
    // markups format the same amount differently, which would otherwise give
    // one advert two identities.
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
  // Kleinanzeigen serves two result-card markups: the legacy `article.aditem`
  // inside `li.ad-listitem`, and a utility-class rewrite where every
  // `.aditem*`/`.ad-listitem` class is gone. `data-adid` on the article is the
  // only anchor present in both, so match on that and keep every field
  // selector tolerant of either DOM.
  crawlContainer: '#srchrslt-adtable article[data-adid]',
  pagination: { urlForPage: kleinanzeigenPage, maxPages: 3 },
  //sort by date is standard oO
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
