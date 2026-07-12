/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Google Geocoding client used by the ingestion pipeline and the backfill
 * CLI. Tuned for German (Berlin-centric) listing addresses: postcode and
 * street plausibility checks reject Google results that merely "snap" to a
 * different street or postcode, and synthetic portal postcodes (10000/12000)
 * get a Berlin-scoped retry.
 */

import { normalizeAddress, addressKey } from '../address.js';

export { normalizeAddress, addressKey };

const GOOGLE_GEOCODING_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const REQUEST_TIMEOUT_MS = 30000;

/*
 * Thrown when Google could not be asked at all (transport error, quota,
 * denied key, server-side glitch). Callers must treat this as retryable and
 * must NOT record it as a definitive "address not found" failure.
 */
export class GeocodeUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GeocodeUnavailableError';
  }
}

/**
 * Whether Google geocoding is configured (API key present).
 * @returns {boolean}
 */
export function isGoogleGeocodingConfigured() {
  return Boolean(process.env.GOOGLE_GEOCODING_API_KEY);
}

/**
 * Address autocomplete for the UI (home-address picker): geocode the partial
 * query, Germany-scoped, and return formatted address candidates.
 *
 * @param {string} query
 * @returns {Promise<string[]>} formatted address suggestions
 */
export async function autocomplete(query) {
  if (!isGoogleGeocodingConfigured()) return [];
  const response = await requestGoogle({ kind: 'freeform', address: appendGermany(normalizeAddress(query)) });
  if (response.status !== 'OK') return [];
  return (response.results || [])
    .map((result) => result.formatted_address)
    .filter(Boolean)
    .slice(0, 5);
}

/**
 * Geocodes a German listing address with postcode and street plausibility checks.
 *
 * @param {string} address
 * @returns {Promise<{lat: number, lng: number, accuracy: string, placeId: string|null, formattedAddress: string|null}|null>}
 */
export async function geocodeAddress(address) {
  const parsed = parseAddress(address);
  const candidates = buildCandidates(parsed);

  for (const candidate of candidates) {
    const response = await requestGoogle(candidate);
    if (response.status !== 'OK') continue;

    for (const item of response.results || []) {
      const accepted = acceptResult(item, parsed, candidate);
      if (accepted) return accepted;
    }
  }

  return null;
}

async function requestGoogle(candidate) {
  const apiKey = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_GEOCODING_API_KEY is required');
  }

  const url = new URL(GOOGLE_GEOCODING_URL);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('language', 'de');
  url.searchParams.set('region', 'de');
  url.searchParams.set('address', candidate.address);
  url.searchParams.set('components', 'country:DE');
  if (candidate.postcode) {
    url.searchParams.set('components', `country:DE|postal_code:${candidate.postcode}`);
  }

  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'User-Agent': 'shoberfredy-google-geocoder/1.0',
      },
    });
  } catch (error) {
    throw new GeocodeUnavailableError(`Google geocoding request failed: ${error.message}`);
  }

  if (!response.ok) {
    throw new GeocodeUnavailableError(`Google geocoding request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (['OVER_QUERY_LIMIT', 'OVER_DAILY_LIMIT', 'REQUEST_DENIED', 'UNKNOWN_ERROR'].includes(payload.status)) {
    throw new GeocodeUnavailableError(
      `Google geocoding stopped with status ${payload.status}: ${payload.error_message || 'no detail'}`,
    );
  }
  return payload;
}

function acceptResult(result, parsed, candidate) {
  const components = parseComponents(result.address_components || []);
  if (
    !candidate.allowPostcodeMismatch &&
    parsed.postcode &&
    components.postalCode &&
    components.postalCode !== parsed.postcode
  ) {
    return null;
  }
  if (
    !candidate.allowPostcodeMismatch &&
    parsed.postcode &&
    !components.postalCode &&
    !result.formatted_address?.includes(parsed.postcode)
  ) {
    return null;
  }

  const expectedRoute = normalizeRoute(parsed.street);
  const actualRoute = normalizeRoute(components.route);
  const hasExpectedStreet = expectedRoute.length > 0;
  const routeMatches =
    !hasExpectedStreet ||
    (actualRoute.length > 0 && (actualRoute.includes(expectedRoute) || expectedRoute.includes(actualRoute)));

  if (candidate.kind.startsWith('street') && hasExpectedStreet && !routeMatches) {
    return null;
  }

  if (candidate.requireBerlin && !isBerlinResult(components, result.formatted_address)) {
    return null;
  }

  const location = result.geometry?.location;
  if (!Number.isFinite(location?.lat) || !Number.isFinite(location?.lng)) {
    return null;
  }

  return {
    lat: location.lat,
    lng: location.lng,
    accuracy: accuracyFor(result, candidate, Boolean(hasExpectedStreet && routeMatches)),
    placeId: result.place_id || null,
    formattedAddress: result.formatted_address || null,
  };
}

function accuracyFor(result, candidate, routeMatches) {
  const locationType = result.geometry?.location_type;
  if (locationType === 'ROOFTOP') return 'house';
  if (locationType === 'RANGE_INTERPOLATED') return 'street';
  if (routeMatches && candidate.kind === 'street') return 'street';
  if (candidate.kind === 'postcode') return 'postcode';
  if (locationType === 'APPROXIMATE') return 'district';
  return 'postcode';
}

function parseComponents(components) {
  const out = {};
  for (const component of components) {
    const types = new Set(component.types || []);
    if (types.has('postal_code')) out.postalCode = component.long_name;
    if (types.has('route')) out.route = component.long_name;
    if (types.has('locality')) out.locality = component.long_name;
    if (types.has('administrative_area_level_1')) out.adminArea1 = component.long_name;
    if (types.has('administrative_area_level_2')) out.adminArea2 = component.long_name;
    if (types.has('country')) out.country = component.long_name;
  }
  return out;
}

function isBerlinResult(components, formattedAddress) {
  const values = [components.locality, components.adminArea1, components.adminArea2, formattedAddress].map((value) =>
    String(value || '').toLowerCase(),
  );
  return values.some((value) => /\bberlin\b/.test(value));
}

function parseAddress(address) {
  const normalized = normalizeAddress(address);
  const postcode = normalized.match(/\b\d{5}\b/)?.[0] || null;
  let street = null;

  if (!/^\d{5}\b/.test(normalized) && postcode) {
    street = normalized.split(postcode)[0].replace(/,\s*$/, '').trim();
  }

  return {
    raw: address,
    normalized,
    postcode,
    street,
  };
}

function buildCandidates(parsed) {
  const candidates = [];
  const deAddress = appendGermany(parsed.normalized);

  candidates.push({ kind: parsed.street ? 'street' : 'freeform', address: deAddress, postcode: parsed.postcode });

  if (parsed.street && parsed.postcode) {
    candidates.push({
      kind: 'street',
      address: appendGermany(`${parsed.street}, ${parsed.postcode} Berlin`),
      postcode: parsed.postcode,
    });
  }

  if (parsed.postcode) {
    candidates.push({
      kind: 'postcode',
      address: appendGermany(`${parsed.postcode} Berlin`),
      postcode: parsed.postcode,
    });
  }

  if (parsed.street && parsed.postcode && isLikelySyntheticPostcode(parsed.postcode)) {
    candidates.push({
      kind: 'street_postcode_mismatch',
      address: appendGermany(`${parsed.street}, Berlin`),
      postcode: null,
      allowPostcodeMismatch: true,
      requireBerlin: true,
    });
  }

  return dedupeCandidates(candidates);
}

function isLikelySyntheticPostcode(postcode) {
  return postcode === '10000' || postcode === '12000';
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.kind}:${candidate.address}:${candidate.postcode || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeRoute(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/straße/g, 'strasse')
    .replace(/\bstr\./g, 'strasse')
    .replace(/\b\d+[a-z]?\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function appendGermany(address) {
  return /deutschland|germany/i.test(address) ? address : `${address}, Deutschland`;
}
