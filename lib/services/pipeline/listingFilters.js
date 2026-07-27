/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { firstBlacklistMatch } from '../../utils.js';
import { classifyBlacklist, intentFilterReasons } from './listingIntent.js';
import { blacklistEvidenceText } from './temporaryDeterministic.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { addressKey } from '../geocoding/address.js';
import { getCachedAccuracy } from '../geocoding/geocodeCache.js';
import { geocodeAddress } from '../geocoding/geoCodingService.js';

// Geocode precisions confident enough to reject a listing before the LLM.
// Coarser precisions (postcode/district) can straddle a polygon border, so a
// listing is never rejected pre-LLM on them — it falls through to the LLM.
const REJECTABLE_PRECISION = new Set(
  (process.env.FREDY_PRELLM_AREA_MIN_PRECISION || 'house,street')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

/**
 * The deterministic filter is intentionally small and terminal. It may only
 * reject evidence; it must never manufacture a canonical value for the LLM.
 * `deterministic` (tier-2 detail facts, optional) tightens the blacklist and
 * specification checks; when absent, behavior is unchanged.
 *
 * It used to take the captured page as a further argument. Reading it turned
 * out to be the wrong trade at this stage — see the note on evidence below —
 * and the parameter is gone rather than left ignored, so no caller believes the
 * page is still being consulted here.
 *
 * @param {object} discovery discovery card
 * @param {object} job owning job, for blacklist and specification
 * @param {object} [deterministic] tier-2 facts mined from the detail evidence
 * @returns {{code: string, stage: string}[]}
 */
export function preLlmFilterReasons(discovery, job, deterministic) {
  const reasons = [];
  const blacklist = job?.blacklist || [];
  // Evidence is checked field by field rather than as one blob so the reason can
  // name both the term and where it was found.
  //
  // The whole captured page is deliberately not evidence here. This stage runs
  // before the listing is understood, and its only job is to save an LLM call
  // on an offer that is obviously unwanted — so it has to be precise, and page
  // text is not: it carries sidebars of similar ads and portal boilerplate, and
  // it varies between captures of the same ad, which made the verdict itself
  // vary. Whatever the page really says is read by the LLM a moment later and
  // decided properly by the structured intent filter.
  const evidence = [
    ['title', discovery?.title],
    ['description', discovery?.description],
    ['address', discovery?.address],
    ['detail_address', deterministic?.address?.value],
    ['detail_text', deterministic?.blacklistText],
  ];
  for (const [field, value] of evidence) {
    if (!value) continue;
    const term = firstBlacklistMatch(String(value), blacklist);
    if (term) {
      reasons.push({ code: 'blacklist_pre_llm', stage: 'pre_llm', term, field });
      break;
    }
  }
  reasons.push(...specReasons(specValues(discovery, deterministic), job?.specFilter, 'pre_llm'));
  return uniqueReasons(reasons);
}

/**
 * Prefer confident deterministic detail numbers over the discovery card; fall
 * back to discovery values otherwise. Low-confidence detail numbers are ignored
 * so the specification filter never rejects on a guess (stays fail-open).
 * @returns {{price:*, size:*, rooms:*}}
 */
function specValues(discovery, deterministic) {
  const prefer = (detail, fallback) =>
    detail && detail.value != null && (detail.confidence === 'high' || detail.confidence === 'medium')
      ? detail.value
      : fallback;
  return {
    price: prefer(deterministic?.price, discovery?.price),
    size: prefer(deterministic?.size, discovery?.size),
    rooms: prefer(deterministic?.rooms, discovery?.rooms),
  };
}

/**
 * Area (spatial polygon) filter evaluated BEFORE the LLM call. Uses ImmoScout's
 * rooftop expose coordinates when available, otherwise geocodes the
 * deterministic detail (or discovery) address. Rejects only when the location
 * is confidently precise AND clearly outside every polygon; anything coarse,
 * not-found, or unavailable falls through to the LLM (fail-open). Async and
 * therefore kept out of the synchronous {@link preLlmFilterReasons}.
 * @returns {Promise<{code:string, stage:string}|null>}
 */
export async function preLlmAreaReason(discovery, deterministic, job) {
  const polygons = job?.spatialFilter?.features?.filter((feature) => feature.geometry?.type === 'Polygon');
  if (!polygons?.length) return null;

  let latitude;
  let longitude;
  const coords = deterministic?.coords;
  if (coords && coords.precision === 'exact' && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
    latitude = coords.lat;
    longitude = coords.lng;
  } else {
    const address = deterministic?.address?.value || discovery?.address;
    if (!address) return null;
    const point = await geocodeAddress(address);
    if (!point || !Number.isFinite(point.lat) || point.lat === -1) return null; // unavailable / not found
    const accuracy = getCachedAccuracy(SqliteConnection.getConnection(), addressKey, address);
    if (!REJECTABLE_PRECISION.has(accuracy)) return null; // coarse → let the LLM decide
    latitude = point.lat;
    longitude = point.lng;
  }

  const inside = polygons.some((polygon) => booleanPointInPolygon([longitude, latitude], polygon));
  return inside ? null : { code: 'area_filter', stage: 'pre_llm' };
}

export function postLlmFilterReasons(listing, job) {
  const reasons = [];
  const blacklist = job?.blacklist || [];

  // Authoritative layer: the LLM has read the whole page and already answered
  // "is this a swap / sublet / WG room / furnished / fixed-term?" as validated
  // enum fields. Ask those instead of hunting for the words that imply them.
  reasons.push(...intentFilterReasons(listing?.attributes, blacklist));

  // Terms the schema cannot express — portal names and the like — still need
  // the text matcher. Terms that map to an intent are excluded here so a
  // structured "no" cannot be overridden by the word appearing in a sidebar.
  const { unmappedTerms } = classifyBlacklist(blacklist);
  if (unmappedTerms.length) {
    const evidence = [
      ['title', listing?.title],
      ['address', listing?.address],
      ['description', blacklistEvidenceText(listing?.description)],
    ];
    for (const [field, value] of evidence) {
      if (!value) continue;
      const term = firstBlacklistMatch(String(value), unmappedTerms);
      if (term) {
        reasons.push({ code: 'blacklist', stage: 'post_llm', term, field });
        break;
      }
    }
  }
  reasons.push(...specReasons(listing, job?.specFilter, 'post_llm'));

  // A listing with no rent cannot be judged: it escapes maxPrice (the spec
  // filter can only compare a number), it cannot be scored against the market
  // model, and it is not actionable — you cannot decide about a flat whose
  // price nobody has stated. The LLM has read the whole page by this point, so
  // a still-missing price means the ad genuinely does not name one.
  if (!positive(listing?.price)) {
    reasons.push({ code: 'no_price', stage: 'post_llm' });
  }

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
