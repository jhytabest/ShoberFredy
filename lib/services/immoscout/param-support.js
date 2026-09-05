/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import {
  ALL_TYPES,
  APARTMENTS,
  APARTMENT_RENT,
  ASSISTED_LIVING,
  BUY_TYPES,
  COMPULSORY_AUCTION,
  FLATSHARE_ROOM,
  GARAGE_BUY,
  GARAGE_RENT,
  HOUSES,
  HOUSE_BUY,
  LIVING_BUY_SITE,
  LIVING_SPACES,
  RENT_TYPES,
  SHORT_TERM,
  allTypesExcept,
} from './real-estate-types.js';

export const PARAM_SUPPORT = {
  exclusioncriteria: ALL_TYPES,
  osmtags: ALL_TYPES,
  fulltext: ALL_TYPES,
  semanticquery: ALL_TYPES,
  tenantNetwork: ALL_TYPES,
  sorting: ALL_TYPES,
  publishedafter: ALL_TYPES,

  price: allTypesExcept(ASSISTED_LIVING, COMPULSORY_AUCTION),
  freeofcourtageonly: allTypesExcept(ASSISTED_LIVING, COMPULSORY_AUCTION),

  energyefficiencyclasses: allTypesExcept(LIVING_BUY_SITE, GARAGE_BUY, GARAGE_RENT, ASSISTED_LIVING),
  minimuminternetspeed: allTypesExcept(LIVING_BUY_SITE, GARAGE_BUY, GARAGE_RENT, ASSISTED_LIVING),
  equipment: [...LIVING_SPACES, FLATSHARE_ROOM, SHORT_TERM, ASSISTED_LIVING],
  petsallowedtypes: [...RENT_TYPES, FLATSHARE_ROOM, SHORT_TERM, ASSISTED_LIVING],
  livingspace: [...LIVING_SPACES, FLATSHARE_ROOM],
  numberofrooms: [...LIVING_SPACES, SHORT_TERM],
  constructionyear: LIVING_SPACES,
  heatingtypes: LIVING_SPACES,
  newbuilding: LIVING_SPACES,

  pricetype: RENT_TYPES,
  apartmenttypes: APARTMENTS,
  floor: APARTMENTS,
  buildingtypes: HOUSES,
  ground: HOUSES,
  luxurypromotion: BUY_TYPES,
  rented: BUY_TYPES,
  haspromotion: [APARTMENT_RENT],
  constructionphasetypes: [HOUSE_BUY],
  newhomebuilder: [HOUSE_BUY],
};

export const PARAM_VALUE_SUPPORT = {
  pricetype: {
    rentpermonth: RENT_TYPES,
    calculatedtotalrent: [APARTMENT_RENT],
  },
};

const IGNORED_PARAMS = new Set([
  'enteredFrom',
  'centerofsearchaddress',
  'pagenumber',
  'pagesize',
  'searchId',
  'referrer',
]);

const IGNORED_PARAM_PREFIXES = ['utm_', 'cmp_'];

function isNoise(param) {
  return IGNORED_PARAMS.has(param) || IGNORED_PARAM_PREFIXES.some((prefix) => param.startsWith(prefix));
}

export function isSupported(param, value, realType) {
  if (!PARAM_SUPPORT[param]?.includes(realType)) {
    return false;
  }

  const valueSupport = PARAM_VALUE_SUPPORT[param];
  return valueSupport == null || valueSupport[String(value)]?.includes(realType) === true;
}

export function keepSupported(params, realType, source) {
  const supported = {};
  for (const [param, value] of Object.entries(params)) {
    if (isSupported(param, value, realType)) {
      supported[param] = value;
    } else if (PARAM_SUPPORT[param] != null) {
      logger.warn(`ImmoScout: dropping ${source} "${param}=${value}", not supported for ${realType}.`);
    } else if (!isNoise(param)) {
      logger.warn(
        `ImmoScout: no translator for ${source} "${param}=${value}" (${realType}), the filter is ignored. ` +
          `Please report the search URL at https://github.com/orangecoding/fredy/issues so it can be added.`,
      );
    }
  }
  return supported;
}
