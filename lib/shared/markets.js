/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export function normalizeMarket(city) {
  const folded = String(city ?? '')
    .toLocaleLowerCase('de-DE')
    .replace(/ä/gu, 'ae')
    .replace(/ö/gu, 'oe')
    .replace(/ü/gu, 'ue')
    .replace(/ß/gu, 'ss')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return folded || null;
}

export function resolveListingMarket({ locality, fallbackCity }) {
  return normalizeMarket(locality) ?? normalizeMarket(fallbackCity);
}
