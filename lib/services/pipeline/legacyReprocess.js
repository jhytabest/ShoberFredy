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
