/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import {
  APARTMENT_BUY,
  APARTMENT_RENT,
  ASSISTED_LIVING,
  COMPULSORY_AUCTION,
  FLATSHARE_ROOM,
  GARAGE_BUY,
  GARAGE_RENT,
  HOUSE_BUY,
  HOUSE_RENT,
  INVESTMENT,
  LIVING_BUY_SITE,
  SHORT_TERM,
} from './real-estate-types.js';

export const DEFAULT_PARAMS_BY_TYPE = {
  [APARTMENT_RENT]: { exclusioncriteria: ['swapflat'] },
};

const BASE_PATHS = {
  'wohnung-mieten': APARTMENT_RENT,
  'wohnung-kaufen': APARTMENT_BUY,
  'haus-mieten': HOUSE_RENT,
  'haus-kaufen': HOUSE_BUY,
  anlageimmobilie: INVESTMENT,
  'grundstueck-kaufen': LIVING_BUY_SITE,
  'garage-kaufen': GARAGE_BUY,
  'garage-mieten': GARAGE_RENT,
  'wg-zimmer': FLATSHARE_ROOM,
  'wohnen-auf-zeit': SHORT_TERM,
  seniorenwohnen: ASSISTED_LIVING,
  zwangsversteigerung: COMPULSORY_AUCTION,
};

const APARTMENT_SLUGS = {
  souterrainwohnung: { apartmenttypes: ['halfbasement'] },
  erdgeschosswohnung: { apartmenttypes: ['groundfloor'] },
  hochparterrewohnung: { apartmenttypes: ['raisedgroundfloor'] },
  etagenwohnung: { apartmenttypes: ['apartment'] },
  loft: { apartmenttypes: ['loft'] },
  maisonette: { apartmenttypes: ['maisonette'] },
  terrassenwohnung: { apartmenttypes: ['terracedflat'] },
  penthouse: { apartmenttypes: ['penthouse'] },
  dachgeschosswohnung: { apartmenttypes: ['roofstorey'] },

  'wohnung-mit-garage': { equipment: ['parking'] },
  'wohnung-mit-einbaukueche': { equipment: ['builtinkitchen'] },
  'wohnung-mit-keller': { equipment: ['cellar'] },
  'wohnung-mit-balkon': { equipment: ['balcony'] },
  'wohnung-mit-garten': { equipment: ['garden'] },

  neubauwohnung: { newbuilding: true },
  'barrierefreie-wohnung': { equipment: ['handicappedaccessible'] },

  altbauwohnung: { fulltext: 'altbau' },
  'wohnung-von-privat': { fulltext: 'privat' },
};

const HOUSE_SLUGS = {
  einfamilienhaus: { buildingtypes: ['singlefamilyhouse'] },
  doppelhaushaelfte: { buildingtypes: ['semidetachedhouse'] },
  reihenhaus: { buildingtypes: ['terracehouse'] },
  bungalow: { buildingtypes: ['bungalow'] },
  mehrfamilienhaus: { buildingtypes: ['multifamilyhouse'] },
  bauernhaus: { buildingtypes: ['farmhouse'] },
  villa: { buildingtypes: ['villa'] },

  'haus-mit-garage': { equipment: ['parking'] },
  'haus-mit-keller': { equipment: ['cellar'] },

  neubauhaus: { newbuilding: true },
};

const WHOLE_SLUGS = [
  ['luxushaus-kaufen', HOUSE_BUY, { luxurypromotion: true }],
  ['luxuswohnung-kaufen', APARTMENT_BUY, { luxurypromotion: true }],
  ['guenstiges-haus-kaufen', HOUSE_BUY, { price: '-100000.0' }],
  ['guenstige-wohnung-kaufen', APARTMENT_BUY, { price: '-100000.0' }],
  ['guenstige-wohnung-mieten', APARTMENT_RENT, { price: '-400.0', pricetype: 'rentpermonth' }],
  ['studentenwohnung-mieten', APARTMENT_RENT, { price: '-350.0', pricetype: 'rentpermonth' }],
  ['moeblierte-wohnung-mieten', APARTMENT_RENT, { fulltext: 'möbliert' }],
  ['provisionsfreies-haus-kaufen', HOUSE_BUY, { freeofcourtageonly: true }],
  ['provisionsfreie-wohnung-kaufen', APARTMENT_BUY, { freeofcourtageonly: true }],
  ['haus-bauen', HOUSE_BUY, { newhomebuilder: true }],
  ['besondere-immobilien', HOUSE_BUY, { buildingtypes: ['specialrealestate'] }],

  ['wohnung-kaufen-mit-balkon', APARTMENT_BUY, { equipment: ['balcony'] }],
  ['eigentumswohnung-mit-garten', APARTMENT_BUY, { equipment: ['garden'] }],

  ['bestandswohnung-mieten', APARTMENT_RENT, {}, { exclusioncriteria: ['swapflat', 'projectlisting'] }],
  ['mietwohnungen-mit-tauschwohnungen', APARTMENT_RENT, {}, { exclusioncriteria: [] }],
];

const WEB_PATHS = {};

for (const [slug, realType] of Object.entries(BASE_PATHS)) {
  WEB_PATHS[slug] = { realType, params: {} };
}
for (const [slug, params] of Object.entries(APARTMENT_SLUGS)) {
  WEB_PATHS[`${slug}-mieten`] = { realType: APARTMENT_RENT, params };
  WEB_PATHS[`${slug}-kaufen`] = { realType: APARTMENT_BUY, params };
}
for (const [slug, params] of Object.entries(HOUSE_SLUGS)) {
  WEB_PATHS[`${slug}-mieten`] = { realType: HOUSE_RENT, params };
  WEB_PATHS[`${slug}-kaufen`] = { realType: HOUSE_BUY, params };
}
for (const [slug, realType, params, defaults] of WHOLE_SLUGS) {
  WEB_PATHS[slug] = { realType, params, defaults };
}

const WEB_PATH_PATTERNS = [
  {
    pattern: /^(?<rooms>[1-6])-zimmer-wohnung-(?<deal>mieten|kaufen)$/,
    resolve: ({ rooms, deal }) => ({
      realType: deal === 'mieten' ? APARTMENT_RENT : APARTMENT_BUY,
      params: { numberofrooms: rooms === '6' ? '6.0-' : `${rooms}.0-${rooms}.5` },
    }),
    example: '3-zimmer-wohnung-mieten',
  },
  {
    pattern: /^wohnung-bis-(?<price>\d+)-euro-warm$/,
    resolve: ({ price }) => ({
      realType: APARTMENT_RENT,
      params: { price: `-${price}`, pricetype: 'calculatedtotalrent' },
    }),
    example: 'wohnung-bis-800-euro-warm',
  },
];

export function resolveWebPath(slug) {
  if (WEB_PATHS[slug]) {
    return WEB_PATHS[slug];
  }

  for (const { pattern, resolve } of WEB_PATH_PATTERNS) {
    const match = slug.match(pattern);
    if (match) {
      return resolve(match.groups);
    }
  }

  return null;
}

export function listKnownWebPaths() {
  return [...Object.keys(WEB_PATHS), ...WEB_PATH_PATTERNS.map(({ example }) => example)];
}
