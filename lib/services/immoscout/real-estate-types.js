/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export const APARTMENT_RENT = 'apartmentrent';
export const APARTMENT_BUY = 'apartmentbuy';
export const HOUSE_RENT = 'houserent';
export const HOUSE_BUY = 'housebuy';
export const INVESTMENT = 'investment';
export const LIVING_BUY_SITE = 'livingbuysite';
export const GARAGE_BUY = 'garagebuy';
export const GARAGE_RENT = 'garagerent';
export const FLATSHARE_ROOM = 'flatshareroom';
export const SHORT_TERM = 'shorttermaccommodation';
export const ASSISTED_LIVING = 'assistedliving';
export const COMPULSORY_AUCTION = 'compulsoryauction';

export const APARTMENTS = [APARTMENT_RENT, APARTMENT_BUY];

export const HOUSES = [HOUSE_RENT, HOUSE_BUY];

export const LIVING_SPACES = [...APARTMENTS, ...HOUSES];

export const BUY_TYPES = [APARTMENT_BUY, HOUSE_BUY];

export const RENT_TYPES = [APARTMENT_RENT, HOUSE_RENT];

export const ALL_TYPES = [
  ...LIVING_SPACES,
  INVESTMENT,
  LIVING_BUY_SITE,
  GARAGE_BUY,
  GARAGE_RENT,
  FLATSHARE_ROOM,
  SHORT_TERM,
  ASSISTED_LIVING,
  COMPULSORY_AUCTION,
];

export function allTypesExcept(...types) {
  return ALL_TYPES.filter((type) => !types.includes(type));
}
