/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Pure classification for the one-time legacy → v4 reconciliation (see
 * tools/parsing/reprocessLegacy.js). Decides, from a listing's stored data and
 * its captured detail evidence, whether under CURRENT filter standards it is
 * terminal (single reason, no LLM) or worth a fresh LLM extraction. Uses stored
 * coordinates only — no geocoding — so it stays synchronous and side-effect free.
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { extractDeterministicDetail } from './deterministicDetail.js';
import { preLlmFilterReasons, primaryFilterReason } from './listingFilters.js';
import { addressKey } from '../geocoding/address.js';

const TRUSTED_GEO_PRECISIONS = new Set(['house', 'street']);

/**
 * Area check against the listing's STORED coordinates. Mirrors the post-LLM
 * spatial filter: reject only when coordinates exist and fall outside every
 * polygon; missing/failed coordinates are left for the LLM pass.
 * @returns {{code: string, stage: string}|null}
 */
export function storedAreaReason(listing, job) {
  const polygons = job?.spatialFilter?.features?.filter((feature) => feature.geometry?.type === 'Polygon');
  if (!polygons?.length) return null;
  const latitude = Number(listing?.latitude);
  const longitude = Number(listing?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude === -1) return null;
  return polygons.some((polygon) => booleanPointInPolygon([longitude, latitude], polygon))
    ? null
    : { code: 'area_filter', stage: 'reprocess' };
}

/**
 * Decide the reconciliation action for one legacy listing under current rules.
 * @param {{listing: object, capture: object|null, discovery: object, job: object|null}} input
 * @returns {{action: 'terminal', reason: string} | {action: 'reprocess', reason: null}}
 */
export function classifyLegacyListing({ listing, capture, discovery, job }) {
  const hasDetail = Boolean(capture && typeof capture.fullText === 'string' && capture.fullText.trim());
  // No verified detail evidence (or no owning job) → cannot be re-evaluated;
  // treat as terminal, excluded from view and from the market model.
  if (!hasDetail || !job) return { action: 'terminal', reason: 'no_detail' };

  const deterministic = extractDeterministicDetail(capture, discovery);
  const textReasons = preLlmFilterReasons(capture, discovery, job, deterministic);
  const area = storedAreaReason(listing, job);
  const reasons = area ? [...textReasons, area] : textReasons;
  if (reasons.length) return { action: 'terminal', reason: primaryFilterReason(reasons) };
  return { action: 'reprocess', reason: null };
}

/**
 * Classify only a genuine pre-pipeline legacy listing for the separate
 * pre-LLM archive. Unlike the old reconciliation this deliberately ignores
 * the job specification filter: a detailed, non-blacklisted listing with a
 * confirmed in-polygon location earns a v4 LLM extraction, and normal
 * post-LLM filters decide whether it is visible in production.
 *
 * Stored listing coordinates are not trusted without provenance. Exact
 * provider coordinates and cached house/street geocodes are decisive;
 * postcode/district/failed/missing provenance is terminal for this one-time
 * historical migration.
 */
export function classifyHistoricalListing({ db, listing, capture, discovery, job }) {
  if (!capture?.fullText?.trim()) {
    return archive('no_detail', { geoState: 'not_evaluated', geoPrecision: null });
  }
  if (!job) return archive('missing_job', { geoState: 'not_evaluated', geoPrecision: null });

  const deterministic = extractDeterministicDetail(capture, discovery);
  const blacklist = preLlmFilterReasons(capture, discovery, job, deterministic).find(
    ({ code }) => code === 'blacklist_pre_llm',
  );
  if (blacklist) {
    return archive('blacklist_pre_llm', {
      geoState: 'not_evaluated',
      geoPrecision: null,
      deterministic: deterministicSummary(deterministic),
    });
  }

  const geo = historicalGeoDecision(db, listing, discovery, deterministic, job);
  if (geo.state === 'inside' || geo.state === 'not_required') {
    return {
      action: 'migrate',
      reason: null,
      geoState: geo.state,
      geoPrecision: geo.precision,
      geoAddress: geo.address,
      deterministic: deterministicSummary(deterministic),
    };
  }
  const reason = geo.state === 'outside' ? 'area_outside' : geo.state === 'coarse' ? 'area_coarse' : 'area_unresolved';
  return archive(reason, {
    geoState: geo.state,
    geoPrecision: geo.precision,
    geoAddress: geo.address,
    deterministic: deterministicSummary(deterministic),
  });
}

function historicalGeoDecision(db, listing, discovery, deterministic, job) {
  const polygons = job?.spatialFilter?.features?.filter((feature) => feature.geometry?.type === 'Polygon');
  if (!polygons?.length) return { state: 'not_required', precision: 'not_required', address: null };

  let latitude;
  let longitude;
  let precision;
  let address = deterministic?.address?.value || discovery?.address || listing?.address || null;
  if (
    deterministic?.coords?.precision === 'exact' &&
    Number.isFinite(deterministic.coords.lat) &&
    Number.isFinite(deterministic.coords.lng)
  ) {
    latitude = deterministic.coords.lat;
    longitude = deterministic.coords.lng;
    precision = 'provider_exact';
  } else if (address) {
    const cached = db
      .prepare(
        `SELECT status, accuracy, latitude, longitude
         FROM homeserver_geocode_cache WHERE address_key = ?`,
      )
      .get(addressKey(address));
    precision = cached?.status === 'ok' ? cached.accuracy : cached?.status || 'no_cache';
    if (
      cached?.status === 'ok' &&
      TRUSTED_GEO_PRECISIONS.has(cached.accuracy) &&
      Number.isFinite(cached.latitude) &&
      Number.isFinite(cached.longitude)
    ) {
      latitude = cached.latitude;
      longitude = cached.longitude;
    }
  } else {
    precision = 'no_address';
  }

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    const state = ['district', 'postcode'].includes(precision) ? 'coarse' : 'unresolved';
    return { state, precision, address };
  }
  const inside = polygons.some((polygon) => booleanPointInPolygon([longitude, latitude], polygon));
  return { state: inside ? 'inside' : 'outside', precision, address };
}

function deterministicSummary(deterministic) {
  return {
    price: deterministic?.price ?? null,
    size: deterministic?.size ?? null,
    rooms: deterministic?.rooms ?? null,
    address: deterministic?.address ?? null,
    coords: deterministic?.coords ?? null,
  };
}

function archive(reason, details) {
  return { action: 'archive', reason, ...details };
}
