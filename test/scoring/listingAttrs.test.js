/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import { parseGermanNumber, parseListingAttrs } from '../../lib/services/scoring/listingAttrs.js';

describe('parseGermanNumber', () => {
  it('parses German thousands/decimal notation', () => {
    expect(parseGermanNumber('1.234,56 €')).toBe(1234.56);
    expect(parseGermanNumber('850,50')).toBe(850.5);
  });

  it('does not truncate plain numbers', () => {
    expect(parseGermanNumber('1999')).toBe(1999);
  });

  it('returns null for non-numbers', () => {
    expect(parseGermanNumber('keine Angabe')).toBe(null);
    expect(parseGermanNumber(null)).toBe(null);
  });
});

describe('parseListingAttrs', () => {
  it('extracts rent breakdown from immoscout-style attribute lines', () => {
    const attrs = parseListingAttrs({
      provider: 'immoscout',
      title: 'Schöne 2-Zimmer Wohnung',
      description: [
        'Kaltmiete: 1.200 €',
        'Nebenkosten: 250 €',
        'Gesamtmiete: 1.450 €',
        'Baujahr: 1910',
        'Etage: 3 von 5',
      ].join('\n'),
      price: 1200,
      size: 65,
    });
    expect(attrs.coldRentEur).toBe(1200);
    expect(attrs.warmRentEur).toBe(1450);
    expect(attrs.serviceChargesEur).toBe(250);
    expect(attrs.priceType).toBe('cold');
    expect(attrs.buildingYear).toBe(1910);
    expect(attrs.floor).toBe(3);
    expect(attrs.rooms).toBe(2);
  });

  it('leaves warm-to-cold conversion to the shared market target', () => {
    const attrs = parseListingAttrs({
      provider: 'wgGesucht',
      title: 'Wohnung',
      description: 'Gesamtmiete: 1.000 €\nNebenkosten: 200 €',
      price: 1000,
    });
    expect(attrs.priceType).toBe('warm');
    expect(attrs.coldRentEur).toBeNull();
    expect(attrs.warmRentEur).toBe(1000);
    expect(attrs.serviceChargesEur).toBe(200);
  });

  it('falls back to provider defaults for the price type', () => {
    expect(parseListingAttrs({ provider: 'immowelt', price: 900 }).priceType).toBe('cold');
    expect(parseListingAttrs({ provider: 'kleinanzeigen', price: 900 }).priceType).toBe('unknown');
  });

  it('detects swap listings', () => {
    expect(parseListingAttrs({ title: 'Tauschwohnung: 3 Zi gegen 2 Zi' }).swap).toBe(true);
    expect(parseListingAttrs({ title: 'Normale Wohnung' }).swap).toBe(false);
  });

  it('parses floor from immowelt-style titles', () => {
    expect(parseListingAttrs({ title: 'Wohnung·9. Geschoss·frei ab 01.08.2026' }).floor).toBe(9);
    expect(parseListingAttrs({ title: 'Erdgeschoss Altbau' }).floor).toBe(0);
  });

  it('bounds implausible building years', () => {
    expect(parseListingAttrs({ description: 'Baujahr: 1700' }).buildingYear).toBe(null);
  });
});
