/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { normalizeAddress, addressKey } from '../address.js';
import SqliteConnection from '../../storage/SqliteConnection.js';
import { storeAuditPayload } from '../../storage/auditPayloadStorage.js';
import { sha256 } from '../../../shared/hash.js';
import { redact } from '../../logger.js';

const GOOGLE_GEOCODING_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const REQUEST_TIMEOUT_MS = 30000;

export class GeocodeUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GeocodeUnavailableError';
  }
}

export function isGoogleGeocodingConfigured() {
  return Boolean(process.env.GOOGLE_GEOCODING_API_KEY);
}

// `city` is the search's own city. Adverts routinely give a street and nothing
// else, and a bare German street name matches in a hundred towns, so the
// fallback candidates need somewhere to put it. Passing no city means the
// fallbacks that would need one are simply not tried.
export async function geocodeAddress(address, { city = null, signal, audit = {} } = {}) {
  const parsed = parseAddress(address);
  const candidates = buildCandidates(parsed, city);
  const key = addressKey(address, city);
  const signature = sha256(JSON.stringify(candidates));
  const db = SqliteConnection.getConnection();
  const progress = db.prepare('SELECT candidate_index, signature FROM geocode_progress WHERE address_key = ?').get(key);
  const startIndex = progress?.signature === signature ? progress.candidate_index : 0;
  const deadline = AbortSignal.timeout(60000);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;

  for (let index = startIndex; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    signal?.throwIfAborted();
    const db = SqliteConnection.getConnection();
    const auditId = db
      .prepare(
        `INSERT INTO geocode_call_audit
      (address_key, source_address, candidate_json, queue_id, listing_id, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        addressKey(address, city),
        address,
        JSON.stringify(candidate),
        audit.queueId ?? null,
        audit.listingId ?? null,
        Date.now(),
      ).lastInsertRowid;
    let httpStatus = null;
    let payload = null;
    let accepted = null;
    let failure = null;
    try {
      const response = await requestGoogle(candidate, signal);
      httpStatus = response.status;
      if (!response.ok) throw new GeocodeUnavailableError(`Google geocoding HTTP ${response.status}`);
      payload = await response.json();
      signal?.throwIfAborted();
      if (!['OK', 'ZERO_RESULTS'].includes(payload.status)) {
        throw new GeocodeUnavailableError(
          `Google geocoding ${payload.status}: ${payload.error_message || 'no detail'}`,
        );
      }
      for (const item of payload.results || []) {
        accepted = acceptResult(item, parsed, candidate);
        if (accepted) {
          db.prepare('DELETE FROM geocode_progress WHERE address_key = ?').run(key);
          return accepted;
        }
      }
      db.prepare(
        `INSERT INTO geocode_progress (address_key, signature, candidate_index, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(address_key) DO UPDATE SET signature = excluded.signature, candidate_index = excluded.candidate_index, updated_at = excluded.updated_at`,
      ).run(key, signature, index + 1, Date.now());
    } catch (error) {
      failure = redact(String(error?.message || error));
      throw error;
    } finally {
      db.prepare(
        `UPDATE geocode_call_audit SET http_status = ?, provider_status = ?,
        result_json = ?, result_payload_sha256 = ?, error = ?, completed_at = ? WHERE id = ?`,
      ).run(
        httpStatus,
        payload?.status ?? null,
        JSON.stringify({ accepted, resultCount: payload?.results?.length ?? 0 }),
        storeAuditPayload({ accepted, results: payload?.results ?? [] }, db),
        failure,
        Date.now(),
        auditId,
      );
    }
  }
  db.prepare('DELETE FROM geocode_progress WHERE address_key = ?').run(key);
  return null;
}

async function requestGoogle(candidate, signal) {
  const apiKey = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!apiKey) throw new GeocodeUnavailableError('GOOGLE_GEOCODING_API_KEY is required');
  const url = new URL(GOOGLE_GEOCODING_URL);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('language', 'de');
  url.searchParams.set('region', 'de');
  url.searchParams.set('address', candidate.address);
  url.searchParams.set(
    'components',
    candidate.postcode ? `country:DE|postal_code:${candidate.postcode}` : 'country:DE',
  );
  try {
    return await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'shoberfredy-google-geocoder/1.0' },
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw new GeocodeUnavailableError(`Google geocoding request failed: ${redact(error.message)}`);
  }
}

function acceptResult(result, parsed, candidate) {
  const components = parseComponents(result.address_components || []);
  if (components.countryCode !== 'DE') return null;
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

  if (candidate.requireCity && !isCityResult(components, result.formatted_address, candidate.requireCity)) {
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
    // No adminArea2 fallback: in Germany that component is the Kreis/Bezirk,
    // not a city, and using it here used to mint markets like
    // `landkreis_muenchen` or `bezirk_pankow` that fragment city identity.
    // `resolveListingMarket` already falls back to the job's own city when
    // locality is null, which is the better answer.
    locality: components.locality || null,
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
    if (types.has('country')) out.countryCode = component.short_name;
  }
  return out;
}

function isCityResult(components, formattedAddress, city) {
  const wanted = String(city).toLocaleLowerCase('de-DE');
  const values = [components.locality, components.adminArea1, components.adminArea2, formattedAddress].map((value) =>
    String(value || '').toLocaleLowerCase('de-DE'),
  );
  return values.some((value) => value.includes(wanted));
}

function parseAddress(address) {
  const normalized = normalizeAddress(address);
  const postcode = normalized.match(/\b\d{5}\b/)?.[0] || null;
  let street = null;

  if (!/^\d{5}\b/.test(normalized) && postcode) {
    street = normalized.split(postcode)[0].replace(/,\s*$/, '').trim();
  } else if (!postcode) {
    const first = normalized.split(',')[0].trim();
    if (/(?:straße|strasse|str\.?|weg|allee|platz|gasse|ufer|damm|ring|chaussee)(?:\s|\d|$)/i.test(first))
      street = first;
  }

  return {
    raw: address,
    normalized,
    postcode,
    street,
  };
}

function buildCandidates(parsed, city) {
  const candidates = [];
  const bareStreet = parsed.street && !parsed.postcode && parsed.normalized === parsed.street;
  const deAddress = appendGermany(bareStreet && city ? `${parsed.street}, ${city}` : parsed.normalized);

  candidates.push({
    kind: parsed.street ? 'street' : 'freeform',
    address: deAddress,
    postcode: parsed.postcode,
    requireCity: bareStreet ? city : null,
  });

  if (city && parsed.street && parsed.postcode) {
    candidates.push({
      kind: 'street',
      address: appendGermany(`${parsed.street}, ${parsed.postcode} ${city}`),
      postcode: parsed.postcode,
    });
  }

  if (city && parsed.postcode) {
    candidates.push({
      kind: 'postcode',
      address: appendGermany(`${parsed.postcode} ${city}`),
      postcode: parsed.postcode,
    });
  }

  if (city && parsed.street && parsed.postcode && isLikelySyntheticPostcode(parsed.postcode)) {
    candidates.push({
      kind: 'street_postcode_mismatch',
      address: appendGermany(`${parsed.street}, ${city}`),
      postcode: null,
      allowPostcodeMismatch: true,
      requireCity: city,
    });
  }

  return dedupeCandidates(candidates);
}

// Placeholders providers emit when an advert gives no postcode at all. They
// look like Berlin postcodes because Berlin is where they were first seen.
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
    .replace(/ß/gu, 'ss')
    .replace(/\d+[a-z]?/gu, '')
    .replace(/str\.?\b/gu, 'strasse')
    .replace(/[^a-z]+/gu, '')
    .trim();
}

function appendGermany(address) {
  return /deutschland|germany/i.test(address) ? address : `${address}, Deutschland`;
}
