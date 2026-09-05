/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { EXTRACTION_VERSION, listingTool, validateListing } from '../pipeline/listingSchema.js';

export function normalizeExtraction(value) {
  if (!value || typeof value !== 'object') return null;
  const source = value.listing ?? value;
  if (source.offer_kind != null) return structuredClone(source);
  if (!source.rent || !('listing_type' in source)) return null;
  const result = Object.fromEntries(
    Object.keys(listingTool.function.parameters.properties).map((key) => [key, source[key] ?? null]),
  );
  const type = source.listing_type;
  const lease = source.lease_type;
  result.offer_kind = type === 'swap' || lease === 'swap' ? 'swap' : type === 'unknown' ? 'unknown' : 'rental';
  result.unit_kind =
    type === 'wg_room' || source.property_type === 'shared_room'
      ? 'private_room'
      : type === 'rental' || type === 'swap'
        ? 'entire_home'
        : 'unknown';
  result.rental_arrangement = type === 'sublet' || lease === 'sublet' ? 'sublet' : 'unknown';
  result.lease_duration =
    source.available_until || lease === 'fixed' ? 'fixed' : lease === 'unlimited' ? 'indefinite' : 'unstated';
  result.minimum_term_months = null;
  result.evidence = [];
  result.rent = { cold: null, warm: null, deposit: null, ...source.rent, mandatory_extras: null };
  result.amenities = source.amenities ?? [];
  result.available_from = source.available_from ?? 'unknown';
  return result;
}

export function extractionEnvelope(value, provenance = {}) {
  const listing = normalizeExtraction(value);
  if (!listing || !validateListing(listing).valid) return null;
  return {
    schemaVersion: EXTRACTION_VERSION,
    listing,
    provenance: {
      origin:
        value.provenance?.origin ??
        (value.listing?.offer_kind != null || value.offer_kind != null ? 'parsed' : 'legacy'),
      ...value.provenance,
      ...provenance,
    },
  };
}

export function normalizeAttributes(attributes = {}) {
  const a = attributes ?? {};
  const type = a.listingType;
  const lease = a.leaseType;
  return {
    ...a,
    offerKind:
      a.offerKind ??
      (a.swap || type === 'swap' || lease === 'swap'
        ? 'swap'
        : ['rental', 'sublet', 'wg_room'].includes(type)
          ? 'rental'
          : 'unknown'),
    unitKind:
      a.unitKind ??
      (type === 'wg_room' || a.propertyType === 'shared_room'
        ? 'private_room'
        : ['rental', 'swap'].includes(type)
          ? 'entire_home'
          : 'unknown'),
    rentalArrangement: a.rentalArrangement ?? (type === 'sublet' || lease === 'sublet' ? 'sublet' : 'unknown'),
    leaseDuration:
      a.leaseDuration ??
      (a.availableUntil || lease === 'fixed' ? 'fixed' : lease === 'unlimited' ? 'indefinite' : 'unstated'),
    minimumTermMonths: a.minimumTermMonths ?? null,
    mandatoryExtrasEur: a.mandatoryExtrasEur ?? null,
    evidence: a.evidence ?? [],
    extraction: a.extraction ?? { schemaVersion: EXTRACTION_VERSION, origin: 'legacy' },
  };
}

export function attributesFromExtraction(value) {
  const envelope = extractionEnvelope(value);
  if (!envelope) throw new TypeError('Cannot build facts from an invalid extraction');
  const s = envelope.listing;
  const provenance = { ...envelope.provenance };
  delete provenance.input;
  const names = (present) => s.amenities.filter((a) => a.present === present).map((a) => a.name);
  return {
    offerKind: s.offer_kind,
    unitKind: s.unit_kind,
    rentalArrangement: s.rental_arrangement,
    leaseDuration: s.lease_duration,
    minimumTermMonths: s.minimum_term_months,
    coldRentEur: s.rent.cold,
    warmRentEur: s.rent.warm,
    depositEur: s.rent.deposit,
    mandatoryExtrasEur: s.rent.mandatory_extras,
    priceType: s.rent.cold != null ? 'cold' : s.rent.warm != null ? 'warm' : 'unknown',
    floor: s.floor,
    totalFloors: s.total_floors,
    buildingYear: s.building_year,
    propertyType: s.property_type,
    condition: s.condition,
    energyClass: s.energy_class,
    furnishingStatus: s.furnishing_status,
    petsPolicy: s.pets_policy,
    availableFrom: s.available_from,
    availableUntil: s.available_until,
    bedrooms: s.bedrooms,
    bathrooms: s.bathrooms,
    offeredBy: s.offered_by,
    amenities: names(true),
    amenitiesAbsent: names(false),
    evidence: s.evidence,
    comments: s.comments,
    summary: s.summary,
    extraction: { schemaVersion: envelope.schemaVersion, ...provenance },
  };
}
