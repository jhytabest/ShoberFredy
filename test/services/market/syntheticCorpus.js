/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Deterministic synthetic corpus for market-model tests: a city-like point
 * cloud with a known hedonic size effect, a spatial price gradient and
 * log-normal noise, in the exact enriched-row shape corpus.js produces.
 */

import { buildProjection } from '../../../lib/services/market/geo.js';
import { sizeBand, roomsBand } from '../../../lib/services/market/corpus.js';
import { gridKey } from '../../../lib/services/market/geo.js';

export const REFERENCE_LATITUDE = 52.5;

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * True (noise-free) log €/m² for a synthetic listing — tests use this to
 * check predictions against ground truth.
 */
export function trueLogPricePerSqm(size, lng) {
  // Baseline 12 €/m², elasticity -0.2 in size, east-west gradient ±20%.
  return Math.log(12) - 0.2 * Math.log(size / 70) + 0.2 * ((lng - 13.4) / 0.1);
}

/**
 * Generate n enriched corpus rows.
 *
 * @param {number} n
 * @param {{seed?: number, noiseSd?: number, missingCoordsShare?: number}} [options]
 * @returns {{rows: object[], projection: object}}
 */
export function syntheticRows(n, options = {}) {
  const random = rng(options.seed ?? 1234);
  const noiseSd = options.noiseSd ?? 0.08;
  const missingShare = options.missingCoordsShare ?? 0.1;
  const projection = buildProjection(REFERENCE_LATITUDE);
  const now = 1750000000000;

  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const size = Math.round(25 + 95 * random());
    const latitude = 52.45 + 0.1 * random();
    const longitude = 13.3 + 0.2 * random();
    const gauss = Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random());
    const logPpsm = trueLogPricePerSqm(size, longitude) + noiseSd * gauss;
    const pricePerSqm = Math.exp(logPpsm);
    const targetRent = Math.round(pricePerSqm * size);
    const hasCoords = random() >= missingShare;
    const projected = hasCoords ? projection.project(latitude, longitude) : { x: NaN, y: NaN };
    const ageDays = Math.floor(random() * 120);
    const tier = hasCoords ? (random() < 0.7 ? 'trusted' : 'coarse') : 'missing';

    rows.push({
      id: `syn-${i}`,
      link: `https://example.org/expose/${i}`,
      provider: 'synthetic',
      title: `Synthetic flat ${i}`,
      createdAt: now - ageDays * 24 * 60 * 60 * 1000,
      ageDays,
      monthOffset: Math.min(Math.floor(ageDays / 30), 6),
      price: targetRent,
      targetRent,
      priceType: 'cold',
      size,
      rooms: 1 + Math.round(random() * 3),
      floor: random() < 0.2 ? null : Math.floor(random() * 5),
      buildingYear: random() < 0.3 ? null : 1900 + Math.floor(random() * 120),
      propertyType: null,
      latitude: hasCoords ? latitude : null,
      longitude: hasCoords ? longitude : null,
      x: projected.x,
      y: projected.y,
      hasCoords,
      tier,
      clusterId: `solo:syn-${i}`,
      rawPricePerSqm: pricePerSqm,
      pricePerSqm,
      logPricePerSqm: logPpsm,
      area: 'unknown',
      sizeBand: sizeBand(size),
      roomsBand: roomsBand(2),
      geoCell: hasCoords ? gridKey(projected.x, projected.y, 125) : null,
      geocodeQuality: tier === 'trusted' ? 'house' : tier === 'coarse' ? 'postcode' : 'unknown',
      isHidden: false,
      features: {},
      attrs: { swap: false },
    });
  }
  return { rows, projection };
}
