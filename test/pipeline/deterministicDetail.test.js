/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'fs';
import { describe, expect, it } from 'vitest';
import { extractDeterministicDetail } from '../../lib/services/pipeline/deterministicDetail.js';
import { captureHtmlString } from '../../lib/services/pipeline/htmlCapture.js';

function readFixture(name) {
  return fs.readFileSync(new URL(`../testFixtures/${name}`, import.meta.url), 'utf8');
}

describe('extractDeterministicDetail', () => {
  it('reads structured price, size, rooms, address and rooftop coords from an ImmoScout expose', () => {
    const expose = JSON.parse(readFixture('immoscout_detail.json'));
    const capture = {
      provider: 'immoscout',
      fullText: '',
      embeddedData: [{ kind: 'immoscout-expose', value: expose }],
    };
    const det = extractDeterministicDetail(capture, {});

    expect(det.price.value).toBe(1740); // Kaltmiete, not Warmmiete (2110)
    expect(det.price.confidence).toBe('high');
    expect(det.size.value).toBeCloseTo(81.8, 1);
    expect(det.rooms.value).toBe(3);
    expect(det.address.value).toContain('Am Hain 53');
    expect(det.coords).toMatchObject({ precision: 'exact' });
    expect(det.coords.lat).toBeCloseTo(51.26249, 3);
    expect(det.coords.lng).toBeCloseTo(6.76223, 3);
  });

  it('does not trust ImmoScout coordinates when the street has no house number', () => {
    const expose = {
      sections: [
        { type: 'TOP_ATTRIBUTES', attributes: [{ label: 'Kaltmiete', text: '900 €' }] },
        {
          type: 'MAP',
          addressLine1: 'Prenzlauer Berg',
          addressLine2: '10405 Berlin',
          location: { lat: 52.5, lng: 13.4 },
        },
      ],
    };
    const det = extractDeterministicDetail(
      { provider: 'immoscout', embeddedData: [{ kind: 'immoscout-expose', value: expose }] },
      {},
    );
    expect(det.coords).toBeNull(); // centroid, not rooftop
    expect(det.address.value).toBe('Prenzlauer Berg, 10405 Berlin');
    expect(det.price.value).toBe(900);
  });

  it('extracts a single-valued schema.org RealEstateListing but rejects AggregateOffer', () => {
    const listing = {
      kind: 'json-ld',
      value: {
        '@type': 'RealEstateListing',
        name: 'Nice flat',
        offers: { '@type': 'Offer', price: '1200' },
        floorSize: { value: '60' },
        numberOfRooms: 2,
        address: { streetAddress: 'Kastanienallee 1', postalCode: '10119', addressLocality: 'Berlin' },
      },
    };
    const det = extractDeterministicDetail({ provider: 'immowelt', embeddedData: [listing] }, {});
    expect(det.price.value).toBe(1200);
    expect(det.size.value).toBe(60);
    expect(det.rooms.value).toBe(2);
    expect(det.address.value).toContain('Kastanienallee 1');

    const aggregate = {
      kind: 'json-ld',
      value: { '@type': 'RealEstateListing', name: 'WG', offers: { '@type': 'AggregateOffer', price: '450' } },
    };
    const detAgg = extractDeterministicDetail({ provider: 'wgGesucht', embeddedData: [aggregate] }, {});
    expect(detAgg.price.value).toBeNull();
  });

  it('reads unambiguous full-text numbers but refuses conflicting candidates', () => {
    const single = extractDeterministicDetail(
      { provider: 'kleinanzeigen', fullText: 'Wohnfläche 75 m², 3 Zimmer, Kaltmiete 1.200 €', embeddedData: [] },
      {},
    );
    expect(single.size.value).toBe(75);
    expect(single.rooms.value).toBe(3);
    expect(single.price.value).toBe(1200);
    expect(single.size.confidence).toBe('low');

    const conflicting = extractDeterministicDetail(
      {
        provider: 'wgGesucht',
        fullText: '2 Zimmer WG. Zimmer 1: 15 m². Zimmer 2: 20 m². 4 Zimmer insgesamt.',
        embeddedData: [],
      },
      {},
    );
    expect(conflicting.rooms.value).toBeNull(); // 2 vs 4 → ambiguous
    expect(conflicting.size.value).toBeNull(); // 15 vs 20 → ambiguous
  });

  it('never yields a price from the WG-Gesucht detail fixture (AggregateOffer)', () => {
    const capture = captureHtmlString(
      { id: 'wg', link: 'https://www.wg-gesucht.de/wg.1.html' },
      readFixture('wgGesucht_detail.html'),
      {
        provider: 'wgGesucht',
        rootSelectors: ['#main_column', 'main', 'body'],
        embeddedSelectors: [],
      },
    );
    const det = extractDeterministicDetail(capture, {});
    expect(det.price.value).toBeNull();
  });

  it('reads structured size and address from the Immowelt embedded classified payload', () => {
    const capture = captureHtmlString(
      { id: 'iw', link: 'https://www.immowelt.de/expose/iw' },
      readFixture('immowelt_detail.html'),
      {
        provider: 'immowelt',
        rootSelectors: ['main', 'body'],
        embeddedSelectors: ['#__UFRN_LIFECYCLE_SERVERREQUEST__', '#__NEXT_DATA__'],
      },
    );
    const det = extractDeterministicDetail(capture, {});
    expect(det.size.value).toBe(136); // Wohnflaeche, not the Wohnflaeche_Range bucket
    expect(det.address.value).toContain('Sassenberg');
    // This fixture is a sale (Vermarktungsart SELL), so the Kaufpreis must not
    // become a rent price for the maxPrice check.
    expect(det.price.value).toBeNull();
    expect(det.coords).toBeNull(); // immowelt exposes an area polygon, not a point
  });
});
