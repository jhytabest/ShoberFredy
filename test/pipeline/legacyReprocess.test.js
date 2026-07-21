/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import { classifyLegacyListing } from '../../lib/services/pipeline/legacyReprocess.js';

const berlinPolygon = {
  spatialFilter: {
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [13.3, 52.45],
              [13.5, 52.45],
              [13.5, 52.6],
              [13.3, 52.6],
              [13.3, 52.45],
            ],
          ],
        },
      },
    ],
  },
};

const capture = (fullText) => ({ provider: 'immoscout', fullText, embeddedData: [] });
const inBerlin = { latitude: 52.52, longitude: 13.4 };

describe('classifyLegacyListing', () => {
  it('marks listings without detail evidence as terminal no_detail (no LLM)', () => {
    expect(classifyLegacyListing({ listing: { ...inBerlin }, capture: null, discovery: {}, job: {} })).toEqual({
      action: 'terminal',
      reason: 'no_detail',
    });
  });

  it('marks listings whose owning job is gone as no_detail', () => {
    expect(
      classifyLegacyListing({ listing: { ...inBerlin }, capture: capture('Schöne Wohnung'), discovery: {}, job: null }),
    ).toEqual({ action: 'terminal', reason: 'no_detail' });
  });

  it('applies the current blacklist to the captured text', () => {
    const verdict = classifyLegacyListing({
      listing: { ...inBerlin },
      capture: capture('Möbliertes WG-Zimmer, befristet für 3 Monate'),
      discovery: { title: 'WG', price: 500, size: 20, rooms: 1 },
      job: { blacklist: ['befristet'], spatialFilter: berlinPolygon.spatialFilter },
    });
    expect(verdict).toEqual({ action: 'terminal', reason: 'blacklist_pre_llm' });
  });

  it('applies the current specification filter', () => {
    const verdict = classifyLegacyListing({
      listing: { ...inBerlin, price: 3000, size: 40, rooms: 1 },
      capture: capture('Teure kleine Wohnung'),
      discovery: { price: 3000, size: 40, rooms: 1 },
      job: { specFilter: { maxPrice: 2000 }, spatialFilter: berlinPolygon.spatialFilter },
    });
    expect(verdict).toEqual({ action: 'terminal', reason: 'spec_filter' });
  });

  it('area-filters on the stored coordinates when outside the polygon', () => {
    const verdict = classifyLegacyListing({
      listing: { latitude: 51.26, longitude: 6.76, price: 1000, size: 60, rooms: 2 }, // Düsseldorf
      capture: capture('Nette Wohnung'),
      discovery: { price: 1000, size: 60, rooms: 2 },
      job: { spatialFilter: berlinPolygon.spatialFilter },
    });
    expect(verdict).toEqual({ action: 'terminal', reason: 'area_filter' });
  });

  it('reprocesses (fresh LLM) a listing that passes all current filters', () => {
    const verdict = classifyLegacyListing({
      listing: { ...inBerlin, price: 1200, size: 65, rooms: 2 },
      capture: capture('Schöne 2-Zimmer-Wohnung in Berlin, Erstbezug'),
      discovery: { price: 1200, size: 65, rooms: 2, address: 'Kastanienallee 1, 10119 Berlin' },
      job: { blacklist: ['befristet'], specFilter: { maxPrice: 2000 }, spatialFilter: berlinPolygon.spatialFilter },
    });
    expect(verdict).toEqual({ action: 'reprocess', reason: null });
  });
});
