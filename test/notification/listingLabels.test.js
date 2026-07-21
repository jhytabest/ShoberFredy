/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import { listingFactsGerman, amenitiesLabelDe } from '../../lib/notification/listingLabels.js';

describe('listingFactsGerman', () => {
  it('renders the most important fields with German labels', () => {
    const facts = Object.fromEntries(
      listingFactsGerman({
        cold_rent_eur: 900,
        warm_rent_eur: 1150,
        size: 65,
        rooms: 2,
        property_type: 'ground_floor_apartment',
        availability: 'date',
        available_from: '2026-09-01',
        deposit_eur: 2700,
        furnished: 1,
        pets_policy: 'conditional',
        amenities_json: JSON.stringify(['balcony', 'fitted_kitchen']),
      }).map((fact) => [fact.label, fact.value]),
    );
    expect(facts.Miete).toBe('kalt 900 € · warm 1.150 €');
    expect(facts['Größe']).toBe('65 m²');
    expect(facts.Zimmer).toBe('2');
    expect(facts.Typ).toBe('Erdgeschosswohnung');
    expect(facts.Verfügbar).toBe('ab 2026-09-01');
    expect(facts.Kaution).toBe('2.700 €');
    expect(facts['Möblierung']).toBe('möbliert');
    expect(facts.Haustiere).toBe('Haustiere nach Absprache');
    expect(facts.Ausstattung).toBe('Balkon, EBK');
  });

  it('falls back to cold/warm-less price and omits empty fields', () => {
    const facts = listingFactsGerman({ price: 1000, property_type: 'unknown' });
    const miete = facts.find((fact) => fact.label === 'Miete');
    expect(miete.value).toBe('1.000 €');
    expect(facts.some((fact) => fact.label === 'Typ')).toBe(false); // unknown → omitted
  });

  it('prettifies unmapped amenity tokens instead of dropping them', () => {
    expect(amenitiesLabelDe(JSON.stringify(['balcony', 'smart_home']))).toBe('Balkon, smart home');
    expect(amenitiesLabelDe('[]')).toBeNull();
  });
});
