/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { isOneOf } from '../../utils.js';
import { blacklistEvidenceText } from './temporaryDeterministic.js';

/**
 * The deterministic filter is intentionally small and terminal. It may only
 * reject evidence; it must never manufacture a canonical value for the LLM.
 */
export function preLlmFilterReasons(capture, discovery, job) {
  const reasons = [];
  const blacklist = job?.blacklist || [];
  const text = [blacklistEvidenceText(capture?.fullText), discovery?.title, discovery?.description, discovery?.address]
    .filter(Boolean)
    .join('\n');
  if (isOneOf(text, blacklist)) reasons.push({ code: 'blacklist_pre_llm', stage: 'pre_llm' });
  reasons.push(...specReasons(discovery, job?.specFilter, 'pre_llm'));
  return uniqueReasons(reasons);
}

export function postLlmFilterReasons(listing, job) {
  const reasons = [];
  const text = [listing?.title, blacklistEvidenceText(listing?.description), listing?.address]
    .filter(Boolean)
    .join('\n');
  if (isOneOf(text, job?.blacklist || [])) reasons.push({ code: 'blacklist', stage: 'post_llm' });
  reasons.push(...specReasons(listing, job?.specFilter, 'post_llm'));

  const polygons = job?.spatialFilter?.features?.filter((feature) => feature.geometry?.type === 'Polygon');
  if (polygons?.length) {
    const latitude = Number(listing?.latitude);
    const longitude = Number(listing?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      reasons.push({ code: 'no_coordinates', stage: 'post_llm' });
    } else if (!polygons.some((polygon) => booleanPointInPolygon([longitude, latitude], polygon))) {
      reasons.push({ code: 'area_filter', stage: 'post_llm' });
    }
  }
  return uniqueReasons(reasons);
}

export function primaryFilterReason(reasons) {
  return Array.isArray(reasons) && reasons.length ? reasons[0].code : null;
}

function specReasons(values, specFilter, stage) {
  const reasons = [];
  const minRooms = positive(specFilter?.minRooms);
  const minSize = positive(specFilter?.minSize);
  const maxPrice = positive(specFilter?.maxPrice);
  const rooms = positive(values?.rooms);
  const size = positive(values?.size ?? values?.size_sqm);
  const price = positive(values?.price);
  if (minRooms != null && rooms != null && rooms < minRooms) {
    reasons.push({ code: 'spec_filter', stage, field: 'rooms', actual: rooms, required: minRooms });
  }
  if (minSize != null && size != null && size < minSize) {
    reasons.push({ code: 'spec_filter', stage, field: 'size', actual: size, required: minSize });
  }
  if (maxPrice != null && price != null && price > maxPrice) {
    reasons.push({ code: 'spec_filter', stage, field: 'price', actual: price, required: maxPrice });
  }
  return reasons;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function uniqueReasons(reasons) {
  const seen = new Set();
  return reasons.filter((reason) => {
    const key = JSON.stringify(reason);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
