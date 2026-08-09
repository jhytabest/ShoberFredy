/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

// A market is one city's rental market. It is the unit a model is trained on,
// because a flat in Munich and a flat in Berlin answer "what should this cost?"
// differently and a single corpus spanning both answers it for neither.
//
// The key is derived from the city rather than configured beside it: a job
// names its city once, and the same string anchors geocoding, keys the model,
// and labels the metric.

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

// The locality Google returned is better evidence of which market an advert
// belongs to than the search that happened to find it — a job searching Munich
// can still surface a flat one town over. The job's own city is the fallback
// for adverts that never resolved to a locality at all.
//
// Null when neither answers. A listing that cannot be placed in a city is left
// out of every corpus rather than pooled into a market that means nothing.
export function resolveListingMarket({ locality, fallbackCity }) {
  return normalizeMarket(locality) ?? normalizeMarket(fallbackCity);
}
