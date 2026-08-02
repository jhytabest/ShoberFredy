/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * ImmoScout provider using the mobile API to retrieve listings.
 *
 * The mobile API provides the following endpoints:
 * - GET /search/total?{search parameters}: Returns the total number of listings for the given query
 *   Example: `curl -H "User-Agent: ImmoScout_27.12_26.2_._" https://api.mobile.immobilienscout24.de/search/total?searchType=region&realestatetype=apartmentrent&pricetype=calculatedtotalrent&geocodes=%2Fde%2Fberlin%2Fberlin `
 *
 * - POST /search/list?{search parameters}: Actually retrieves the listings. Body is json encoded and contains
 *   data specifying additional results (advertisements) to return. The format is as follows:
 *   ```
 *   {
 *   "supportedResultListTypes": [],
 *   "userData": {}
 *   }
 *   ```
 *   It is not necessary to provide data for the specified keys.
 *
 *   Example: `curl -X POST 'https://api.mobile.immobilienscout24.de/search/list?pricetype=calculatedtotalrent&realestatetype=apartmentrent&searchType=region&geocodes=%2Fde%2Fberlin%2Fberlin&pagenumber=1' -H "Connection: keep-alive" -H "User-Agent: ImmoScout_27.12_26.2_._" -H "Accept: application/json" -H "Content-Type: application/json" -d '{"supportedResultListType": [], "userData": {}}'`

 * - GET /expose/{id} - Returns the details of a listing. The response contains additional details not included in the
 *   listing response.
 *
 *   Example: `curl -H "User-Agent: ImmoScout_27.12_26.2_._" "https://api.mobile.immobilienscout24.de/expose/158382494"`
 *
 *
 * It is necessary to set the correct User Agent (see `getListings`) in the request header.
 *
 * Note that the mobile API is not publicly documented. I've reverse-engineered
 * it by intercepting traffic from an android emulator running the immoscout app.
 * Moreover, the search parameters differ slightly from the web API. I've mapped them
 * to the web API parameters by comparing a search request with all parameters set between
 * the web and mobile API. The mobile API actually seems to be a superset of the web API,
 * but I have decided not to include new parameters as I wanted to keep the existing UX (i.e.,
 * users only have to provide a link to an existing search).
 *
 */

import { buildHash } from '../utils.js';
import { convertWebToMobile } from '../services/immoscout/immoscout-web-translator.js';
import { extractNumber } from '../utils/extract-number.js';
import { queryPage } from '../services/extractor/pagination.js';
import { withOperationDeadline } from '../services/pipeline/operationDeadline.js';
import {
  ProviderTimeoutError,
  ProviderTransientError,
  providerErrorForResponse,
} from '../services/pipeline/providerErrors.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

async function getListings(url) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': 'ImmoScout_27.12_26.2_._',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      supportedResultListTypes: [],
      userData: {},
    }),
  });
  // Throwing rather than returning nothing. An empty result and a refusal are
  // different facts, and collapsing them here is what made every discovery
  // failure look like "no cards discovered" to provider health.
  if (!response.ok) {
    throw providerErrorForResponse(response, {
      message: `ImmoScout Mobile API returned ${response.status} ${response.statusText}`,
    });
  }

  const responseBody = await response.json();
  return responseBody.resultListItems
    .filter((item) => item.type === 'EXPOSE_RESULT')
    .map((expose) => {
      const item = expose.item;
      // The mobile API sends the three card attributes positionally with empty
      // labels: price, living space, room count ("1 Zi."). Dropping the third
      // left every ImmoScout card without a room count.
      const [price, size, rooms] = item.attributes;
      const image = item?.titlePicture?.full ?? item?.titlePicture?.preview ?? null;
      return {
        id: item.id,
        price: price?.value,
        size: size?.value,
        rooms: rooms?.value,
        title: item.title,
        link: `${metaInformation.baseUrl}expose/${item.id}`,
        address: item.address?.line,
        image,
      };
    });
}

async function fetchExpose(listing) {
  const exposeId = listing.link?.split('/').pop();
  const label = `ImmoScout expose ${exposeId}`;
  try {
    return await withOperationDeadline(
      async (signal) => {
        const detailed = await fetch(`https://api.mobile.immobilienscout24.de/expose/${exposeId}`, {
          signal,
          headers: {
            'User-Agent': 'ImmoScout_27.3_26.0_._',
            'Content-Type': 'application/json',
          },
        });
        if (!detailed.ok) throw exposeHttpError(detailed, exposeId);
        const body = await detailed.json();
        signal.throwIfAborted();
        return body;
      },
      { timeoutMs: 60_000, name: label },
    );
  } catch (error) {
    if (error?.code === 'PROVIDER_ERROR') throw error;
    if (error?.code === 'OPERATION_DEADLINE' || error?.name === 'TimeoutError') {
      throw new ProviderTimeoutError(`${label} timed out`, { cause: error });
    }
    throw new ProviderTransientError(`${label} failed: ${error.message}`, { cause: error });
  }
}

async function captureDetails(listing) {
  const detailBody = await fetchExpose(listing);
  const exposeId = listing.link?.split('/').pop();
  const images = (detailBody.sections || [])
    .filter((section) => section.type === 'MEDIA')
    .flatMap((section) => section.media || [])
    .map((media, position) => ({
      position,
      kind: String(media.type || '')
        .toLowerCase()
        .includes('floor')
        ? 'floorplan'
        : 'photo',
      originalUrl: media.fullImageUrl || media.imageUrlForWeb || media.previewImageUrl,
    }))
    .filter((image) => image.originalUrl);
  return {
    provider: metaInformation.id,
    externalId: exposeId,
    sourceUrl: listing.link,
    discoveredAt: listing.discoveredAt ?? Date.now(),
    discoveryData: { ...listing },
    fullText: buildDescription(detailBody),
    embeddedData: [{ kind: 'immoscout-expose', value: detailBody }],
    images,
  };
}

function exposeHttpError(response, exposeId) {
  const retryAfter = Number(response.headers.get('retry-after'));
  return providerErrorForResponse(response, {
    message: `ImmoScout expose ${exposeId} returned ${response.status} ${response.statusText}`,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
  });
}

function buildDescription(detailBody) {
  const sections = detailBody.sections || [];
  const contact = detailBody.contact || {};
  const cData = contact?.contactData || {};
  const agentName = cData?.agent?.name || '';
  const agentCompany = cData?.agent?.company || '';
  const stars = cData?.agent?.rating?.numberOfStars || '';
  const phoneNumbers = contact?.phoneNumbers || [];
  const phoneNumbersMapped = phoneNumbers
    .map((p) => `${p.label}: ${p.text}`)
    .join('\n')
    .trim();

  const sectionText = sections
    .map((section) => {
      const lines = [];
      if (section.title) lines.push(section.title);
      if (section.addressLine1) lines.push(section.addressLine1);
      if (section.addressLine2) lines.push(section.addressLine2);
      if (section.text) lines.push(section.text);
      for (const attr of section.attributes || []) {
        if (attr.label && (attr.text || attr.additionalInfoText)) {
          lines.push(`${attr.label}: ${[attr.text, attr.additionalInfoText].filter(Boolean).join(' ')}`);
        }
      }
      return lines.join('\n');
    })
    .filter(Boolean)
    .join('\n\n');

  return (
    (detailBody.header?.title ? `${detailBody.header.title}\n\n` : '') +
    `Agent: ${agentName ? agentName : 'Unbekannt'} ${agentCompany ? `(${agentCompany}) ` : ''}${stars ? `- ${stars} stars` : ''}\n` +
    (phoneNumbersMapped ? `Phone Numbers:\n${phoneNumbersMapped}` : '') +
    '\n\n' +
    sectionText.trim()
  );
}

function nullOrEmpty(val) {
  return val == null || val.length === 0;
}

/**
 * @param {any} o
 * @returns {ParsedListing}
 */
function normalize(o) {
  const title = (o.title || '').replace('NEU', '').trim();
  const address = nullOrEmpty(o.address) ? 'NO ADDRESS FOUND' : (o.address || '').replace(/\(.*\),.*$/, '').trim();
  const id = buildHash(o.id, o.price);
  return {
    id,
    externalId: String(o.id),
    link: o.link,
    title,
    price: extractNumber(o.price),
    size: extractNumber(o.size),
    rooms: extractNumber(o.rooms),
    address,
    image: o.image,
    description: o.description,
  };
}
/**
 * @param {ParsedListing} o
 * @returns {boolean}
 */
/** @type {ProviderConfig} */
const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  url: null,
  crawlFields: {
    id: 'id',
    title: 'title',
    price: 'price',
    size: 'size',
    rooms: 'rooms',
    link: 'link',
    address: 'address',
  },
  // Not required - used by filter to remove and listings that failed to parse
  sortByDateParam: 'sorting=-firstactivation',
  normalize: normalize,
  getListings: getListings,
  pagination: { urlForPage: (url, page) => queryPage(url, page, 'pagenumber'), maxPages: 3 },
  captureDetails,
};
export const init = (sourceConfig) => {
  config.enabled = sourceConfig.enabled;
  config.url = convertWebToMobile(sourceConfig.url);
};
export const metaInformation = {
  name: 'Immoscout',
  baseUrl: 'https://www.immobilienscout24.de/',
  id: 'immoscout',
};

export { config };
