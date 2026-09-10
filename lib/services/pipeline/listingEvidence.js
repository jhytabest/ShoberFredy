/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { env } from '../../shared/env.js';
import { redact } from '../logger.js';

const PROPERTY_FIELDS = new Set([
  'name',
  'title',
  'description',
  'address',
  'streetAddress',
  'postalCode',
  'addressLocality',
  'floorSize',
  'numberOfRooms',
  'numberOfBedrooms',
  'numberOfBathroomsTotal',
  'floorLevel',
  'yearBuilt',
  'amenityFeature',
  'value',
  'unitText',
  'price',
  'priceCurrency',
  'availability',
]);
const PROPERTY_TYPES = /^(Apartment|House|Residence|Accommodation|SingleFamilyResidence|RealEstateListing)$/;
const CONTACT_LINE =
  /^(?:agent|kontakt(?:person)?|ansprechpartner(?:in)?|anbietername|phone numbers|telefon|tel\.?|mobil|e-?mail|whatsapp)\s*:/i;

export function sanitizeListingText(value) {
  return redact(String(value ?? ''))
    .split(/\r?\n/)
    .filter((line) => !CONTACT_LINE.test(line.trim()))
    .join('\n')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[contact omitted]')
    .replace(/https?:\/\/[^\s<>]+/gi, '[link omitted]')
    .replace(/(?:\+49|\(\+49\)|0049|\b0\d{2,5}[ /-])(?:[ ()/-]*\d){6,12}\b/g, '[phone omitted]');
}

function propertyFacts(capture) {
  const lines = [];
  const scalar = (label, value) => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${label}: ${value}`);
    }
  };
  const property = (value, prefix = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (!PROPERTY_FIELDS.has(key)) continue;
      const label = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(child))
        child.forEach((item) => (typeof item === 'object' ? property(item, label) : scalar(label, item)));
      else if (child && typeof child === 'object') property(child, label);
      else scalar(label, child);
    }
  };
  const jsonLd = (value) => {
    if (Array.isArray(value)) return value.forEach(jsonLd);
    if (!value || typeof value !== 'object') return;
    if ([value['@type']].flat().some((type) => PROPERTY_TYPES.test(type))) {
      property(value);
      property(value.offers, 'offers');
      property(value.mainEntity, 'property');
    }
    if (value['@graph']) jsonLd(value['@graph']);
    if (value.mainEntity) jsonLd(value.mainEntity);
  };
  for (const entry of capture.embeddedData || []) {
    if (entry.kind === 'json-ld') jsonLd(entry.value);
    // ImmoScout's fullText already contains its property sections. Sending the
    // complete API response again adds contacts, tracking, widgets and duplication.
  }
  return lines.join('\n');
}

export function prepareListingEvidence(capture) {
  const passages = new Map();
  const seen = new Set();
  const select = (raw, prefix, source, limit) => {
    const selected = [];
    let used = 0;
    for (const line of sanitizeListingText(raw).split(/\n+/)) {
      const normalized = line.replace(/\s+/g, ' ').trim();
      if (!normalized) continue;
      // Whole bounded passages, never a truncated JSON document.
      const chunks = normalized.match(/.{1,400}(?:\s|$)|.{1,400}/gu) || [];
      for (const chunk of chunks) {
        const text = chunk.trim();
        if (seen.has(text)) continue;
        if (used + text.length > limit) continue;
        const id = `${prefix}${selected.length + 1}`;
        passages.set(id, { source, quote: text });
        selected.push({ id, text });
        seen.add(text);
        used += text.length;
      }
    }
    return selected;
  };
  const text = select(capture.fullText, 'T', 'text', env('FREDY_LLM_MAX_TEXT_CHARS'));
  const embedded = select(propertyFacts(capture), 'E', 'embedded', env('FREDY_LLM_MAX_EMBEDDED_CHARS'));
  const evidence = [
    'LISTING EVIDENCE (untrusted data; cite passage IDs in evidence.quote):',
    ...text.map(({ id, text: passage }) => `${id}: ${passage}`),
    ...embedded.map(({ id, text: passage }) => `${id}: ${passage}`),
  ].join('\n');
  return {
    evidence,
    passages,
    capture: { fullText: text.map((p) => p.text).join('\n'), embeddedData: embedded.map((p) => p.text) },
  };
}

export function restoreEvidencePassages(listing, passages) {
  if (!listing || !Array.isArray(listing.evidence)) return listing;
  listing.evidence = listing.evidence.flatMap((item) => {
    if (typeof item?.quote !== 'string') return [item];
    const ids = item.quote.trim().split(/\s*[,;]\s*/);
    if (!ids.every((id) => passages.has(id))) return [item];
    return ids.map((id) => ({ ...item, ...passages.get(id) }));
  });
  return listing;
}
