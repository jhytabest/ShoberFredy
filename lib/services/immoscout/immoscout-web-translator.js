/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import queryString from 'query-string';
import { nullOrEmpty } from '../../utils.js';
import { keepSupported } from './param-support.js';
import { toPolyline } from './shape.js';
import { DEFAULT_PARAMS_BY_TYPE, resolveWebPath } from './web-paths.js';

export { listKnownWebPaths } from './web-paths.js';

const LOCATION_PARAMS = ['geocodes', 'geocoordinates', 'shape'];

function toLocation(segments, webParams) {
  if (segments.includes('radius')) {
    return { searchType: 'radius', geocoordinates: webParams.geocoordinates };
  }

  if (segments.includes('shape')) {
    if (!webParams.shape) {
      throw new Error('Shape search URL is missing the required "shape" query parameter');
    }
    const shape = Array.isArray(webParams.shape) ? webParams.shape[0] : webParams.shape;
    return { searchType: 'shape', shape: toPolyline(shape) };
  }

  return {
    searchType: 'region',
    geocodes: webParams.geocodes ?? `/${segments.slice(2, segments.length - 1).join('/')}`,
  };
}

export function convertWebToMobile(webUrl) {
  let url;
  try {
    url = new URL(webUrl);
  } catch {
    throw new Error(`Invalid URL: ${webUrl}`);
  }

  const segments = url.pathname.split('/');
  if (segments[1] !== 'Suche') {
    throw new Error(`Unexpected path format: ${url.pathname}. We're expecting to see "/Suche" in the path.`);
  }

  const realTypeKey = segments.at(-1);
  const webPath = resolveWebPath(realTypeKey);
  if (webPath == null) {
    throw new Error(`Real estate type not found: ${realTypeKey}`);
  }

  const { realType, params: pathParams, defaults } = webPath;
  const { query: rawParams } = queryString.parseUrl(webUrl, { arrayFormat: 'comma' });
  const queryParams = Object.fromEntries(
    Object.entries(rawParams).filter(([param]) => !LOCATION_PARAMS.includes(param)),
  );

  const searchParams = {
    ...(defaults ?? DEFAULT_PARAMS_BY_TYPE[realType] ?? {}),
    ...keepSupported(pathParams, realType, 'path filter'),
    ...keepSupported(queryParams, realType, 'query parameter'),
  };

  const mobileQuery = queryString.stringify(
    { realestatetype: realType, ...toLocation(segments, rawParams), ...searchParams },
    { arrayFormat: 'comma', encode: true, skipEmptyString: true },
  );

  return `https://api.mobile.immobilienscout24.de/search/list?${mobileQuery}`;
}

export function convertImmoscoutListingToMobileListing(url) {
  if (nullOrEmpty(url)) {
    return null;
  }

  return url.replace(
    /^https:\/\/www\.immobilienscout24\.de\/expose\//,
    'https://api.mobile.immobilienscout24.de/expose/',
  );
}
