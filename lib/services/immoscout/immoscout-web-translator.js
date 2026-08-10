/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import queryString from 'query-string';
import logger from '../logger.js';

const PARAM_NAME_MAP = {
  heatingtypes: 'heatingtypes',
  haspromotion: 'haspromotion',
  numberofrooms: 'numberofrooms',
  livingspace: 'livingspace',
  energyefficiencyclasses: 'energyefficiencyclasses',
  exclusioncriteria: 'exclusioncriteria',
  equipment: 'equipment',
  petsallowedtypes: 'petsallowedtypes',
  price: 'price',
  constructionyear: 'constructionyear',
  apartmenttypes: 'apartmenttypes',
  buildingtypes: 'buildingtypes',
  ground: 'ground',
  pricetype: 'pricetype',
  floor: 'floor',
  geocodes: 'geocodes',
  geocoordinates: 'geocoordinates',
  shape: 'shape',
  sorting: 'sorting',
  newbuilding: 'newbuilding',
  fulltext: 'fulltext',
};

const EQUIPMENT_MAP = {
  parking: 'parking',
  cellar: 'cellar',
  builtinkitchen: 'builtInKitchen',
  lift: 'lift',
  garden: 'garden',
  guesttoilet: 'guestToilet',
  balcony: 'balcony',
  handicappedaccessible: 'handicappedAccessible',
  lodgerflat: 'lodgerflat',
};

const EXCLUSION_CRITERIA_MAP = {
  swapflat: 'swap_flat',
};

const REAL_ESTATE_TYPE = {
  'haus-mieten': 'houserent',
  'wohnung-mieten': 'apartmentrent',
  'wohnung-kaufen': 'apartmentbuy',
  'wohnung-kaufen-mit-balkon': 'apartmentbuy',
  'eigentumswohnung-mit-garten': 'apartmentbuy',
  'haus-kaufen': 'housebuy',
  'haus-mit-keller-kaufen': 'housebuy',
  'luxushaus-kaufen': 'housebuy',
  'villa-kaufen': 'housebuy',
  'neubauhaus-kaufen': 'housebuy',
};

const WEB_PATH_TO_APARTMENT_EQUIPMENT_MAP = {
  'wohnung-mit-balkon-mieten': { equipment: ['balcony'] },
  'wohnung-kaufen-mit-balkon': { equipment: ['balcony'] },
  'wohnung-mit-garten-mieten': { equipment: ['garden'] },
  'eigentumswohnung-mit-garten': { equipment: ['garden'] },
  'souterrainwohnung-mieten': { apartmenttypes: ['halfbasement'] },
  'erdgeschosswohnung-mieten': { apartmenttypes: ['groundfloor'] },
  'hochparterrewohnung-mieten': { apartmenttypes: ['raisedgroundfloor'] },
  'etagenwohnung-mieten': { apartmenttypes: ['apartment'] },
  'loft-mieten': { apartmenttypes: ['loft'] },
  'maisonette-mieten': { apartmenttypes: ['maisonette'] },
  'terrassenwohnung-mieten': { apartmenttypes: ['terracedflat'] },
  'penthouse-mieten': { apartmenttypes: ['penthouse'] },
  'dachgeschosswohnung-mieten': { apartmenttypes: ['roofstorey'] },
  'wohnung-mit-garage-mieten': { equipment: ['parking'] },
  'wohnung-mit-einbaukueche-mieten': { equipment: ['builtinkitchen'] },
  'wohnung-mit-keller-mieten': { equipment: ['cellar'] },
  'neubauwohnung-mieten': { newbuilding: true },
  'barrierefreie-wohnung-mieten': { equipment: ['handicappedaccessible'] },
};

const SEO_RENT_TYPE_TO_REAL_ESTATE_TYPE = {
  wohnung: 'apartmentrent',
  haus: 'houserent',
};
const SEO_MAX_WARMRENT_PATH_PATTERN = /^(?<type>wohnung|haus)-bis-(?<price>\d+)-euro-warm$/;

function parseSeoMaxWarmrentPath(realTypeKey) {
  const match = realTypeKey.match(SEO_MAX_WARMRENT_PATH_PATTERN);
  if (!match) return null;

  const { type, price } = match.groups;
  return {
    realType: SEO_RENT_TYPE_TO_REAL_ESTATE_TYPE[type],
    additionalParams: {
      price: `-${price}`,
      pricetype: 'calculatedtotalrent',
    },
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
  let realType = REAL_ESTATE_TYPE[realTypeKey];
  let additionalParamsFromWebPath = WEB_PATH_TO_APARTMENT_EQUIPMENT_MAP[realTypeKey] || null;

  if (!realType) {
    if (WEB_PATH_TO_APARTMENT_EQUIPMENT_MAP[realTypeKey]) {
      additionalParamsFromWebPath = WEB_PATH_TO_APARTMENT_EQUIPMENT_MAP[realTypeKey];
      realType = REAL_ESTATE_TYPE['wohnung-mieten'];
    } else {
      const seoMaxWarmrent = parseSeoMaxWarmrentPath(realTypeKey);
      if (seoMaxWarmrent) {
        realType = seoMaxWarmrent.realType;
        additionalParamsFromWebPath = seoMaxWarmrent.additionalParams;
      } else {
        logger.warn(`Real estate type not found: ${realTypeKey}`);
        throw new Error(`Real estate type not found: ${realTypeKey}`);
      }
    }
  }

  const { query: rawParams } = queryString.parseUrl(webUrl, { arrayFormat: 'comma' });
  const webParams = Object.fromEntries(
    Object.entries(rawParams).filter(([key]) => key !== 'enteredFrom' && PARAM_NAME_MAP[key]),
  );

  const geocodes = `/${segments.slice(2, segments.length - 1).join('/')}`;
  const isRadius = segments.includes('radius');
  const isShape = segments.includes('shape');
  const mobileParams = {
    searchType: isRadius ? 'radius' : isShape ? 'shape' : 'region',
    realestatetype: realType,
    ...(isRadius || isShape ? {} : { geocodes }),
    ...additionalParamsFromWebPath,
  };

  if (isShape && !webParams.shape) {
    throw new Error('Shape search URL is missing the required "shape" query parameter');
  }

  if (isShape && webParams.shape) {
    const browserShape = webParams.shape;
    const normalized = browserShape.replace(/\.\./g, '==').replace(/\./g, '=');
    const polyline = Buffer.from(normalized, 'base64').toString('utf-8');
    mobileParams.shape = polyline;
  }

  if (webParams.geocoordinates) {
    mobileParams.geocoordinates = webParams.geocoordinates;
  }

  for (const [key, val] of Object.entries(webParams)) {
    if (key === 'shape') continue;
    if (key === 'equipment') {
      const items = [].concat(val).flatMap((v) => `${v}`.split(','));
      const currentEquipmentParams = mobileParams[PARAM_NAME_MAP[key]];
      mobileParams[PARAM_NAME_MAP[key]] = [
        ...(currentEquipmentParams ?? []),
        ...items.map((item) => EQUIPMENT_MAP[item.toLowerCase()]).filter(Boolean),
      ];
    } else if (key === 'exclusioncriteria') {
      const items = [].concat(val).flatMap((v) => `${v}`.split(','));
      mobileParams[PARAM_NAME_MAP[key]] = items.map((item) => EXCLUSION_CRITERIA_MAP[item.toLowerCase()] ?? item);
    } else {
      mobileParams[PARAM_NAME_MAP[key]] = val;
    }
  }

  const mobileQuery = queryString.stringify(mobileParams, {
    arrayFormat: 'comma',
    encode: true,
    skipEmptyString: true,
  });

  return `https://api.mobile.immobilienscout24.de/search/list?${mobileQuery}`;
}
