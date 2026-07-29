/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { firstBlacklistMatch } from '../../utils.js';
import { classifyBlacklist, intentFilterReasons } from './listingIntent.js';
import { blacklistEvidenceText } from '../listings/claims.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { addressKey } from '../geocoding/address.js';
import { getCachedAccuracy } from '../geocoding/geocodeCache.js';
import { geocodeAddress } from '../geocoding/geoCodingService.js';
import { env } from '../../shared/env.js';
import { positiveNumber } from '../../shared/values.js';

/**
 * One filter, evaluated over whatever facts are known.
 *
 * There used to be three differently-shaped entry points — a discovery-card
 * check, the same function again with tier-2 detail facts, and a post-LLM check
 * over a canonical listing — plus an async area check kept separate because it
 * does I/O, plus a startup reconciler that re-asserted the pre-LLM verdict
 * because the answer was pinned to a stage rather than to the evidence. The
 * blacklist scan, the specification comparison and the polygon test were each
 * written twice, and the shared spec helper had to accept two different input
 * shapes (`values.size ?? values.size_sqm`), which is the tell.
 *
 * Now there is one rule set over a normalised `facts` object. The pipeline fills
 * facts in as it learns them, and the answer depends only on what is known — so
 * calling it earlier is a cost optimisation, never a different verdict. The
 * three exported adapters below exist because callers name their stage in the
 * audit trail, not because the logic differs.
 *
 * The stages remain meaningfully different in one respect, and it is deliberate:
 * before the LLM a rule may only REJECT on evidence it is confident about, and
 * must fall through otherwise. Rejecting a listing that would have passed costs
 * a flat; spending an LLM call on one that would have failed costs a fraction of
 * a cent.
 */

/** Geocode precisions confident enough to reject a listing before the LLM. */
const REJECTABLE_PRECISION = new Set(
  String(env('FREDY_PRELLM_AREA_MIN_PRECISION'))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

/**
 * Normalise whatever the caller knows into one shape.
 *
 * Confident deterministic detail numbers beat the discovery card; low-confidence
 * ones are ignored entirely, so the specification filter never rejects on a
 * guess. Canonical LLM values, when present, beat both.
 *
 * @param {object} [discovery] discovery card
 * @param {object} [deterministic] tier-2 facts mined from the detail evidence
 * @param {object} [listing] canonical listing, once the LLM has produced one
 * @returns {object} facts
 */
export function collectFacts({ discovery, deterministic, listing } = {}) {
  const trusted = (field, fallback) =>
    field && field.value != null && (field.confidence === 'high' || field.confidence === 'medium')
      ? field.value
      : fallback;

  return {
    title: listing?.title ?? discovery?.title ?? null,
    address: listing?.address ?? trusted(deterministic?.address, discovery?.address) ?? null,
    description: listing ? blacklistEvidenceText(listing.description) : (discovery?.description ?? null),
    detailText: deterministic?.blacklistText ?? null,
    price: listing?.price ?? trusted(deterministic?.price, discovery?.price) ?? null,
    size: listing?.size ?? trusted(deterministic?.size, discovery?.size) ?? null,
    rooms: listing?.rooms ?? trusted(deterministic?.rooms, discovery?.rooms) ?? null,
    latitude: listing?.latitude ?? null,
    longitude: listing?.longitude ?? null,
    coords: deterministic?.coords ?? null,
    attributes: listing?.attributes ?? null,
  };
}

/**
 * Every synchronous reason this listing should be hidden, given what is known.
 *
 * @param {object} facts from {@link collectFacts}
 * @param {object} job owning job, for blacklist and specification
 * @param {string} stage recorded on each reason for the audit trail
 * @returns {{code: string, stage: string}[]}
 */
export function filterReasons(facts, job, stage) {
  const reasons = [];
  const blacklist = job?.blacklist || [];
  const structured = facts.attributes != null;

  if (structured) {
    // Authoritative layer: the LLM has read the whole page and already answered
    // "is this a swap / sublet / WG room / furnished / fixed-term?" as validated
    // enum fields. Ask those instead of hunting for the words that imply them.
    reasons.push(...intentFilterReasons(facts.attributes, blacklist));
  }

  // Terms the schema cannot express — portal names and the like — still need the
  // text matcher. Once the structured answer exists, terms that map to an intent
  // are excluded so a structured "no" cannot be overridden by the word appearing
  // in a sidebar.
  const terms = structured ? classifyBlacklist(blacklist).unmappedTerms : blacklist;
  if (terms.length) reasons.push(...blacklistReasons(facts, terms, stage));

  reasons.push(...specReasons(facts, job?.specFilter, stage));

  if (structured) {
    // A listing with no rent cannot be judged: it escapes maxPrice, it cannot be
    // scored against the market model, and it is not actionable — you cannot
    // decide about a flat whose price nobody has stated. The LLM has read the
    // whole page by now, so a still-missing price means the ad names none.
    if (positiveNumber(facts.price) == null) reasons.push({ code: 'no_price', stage });
    reasons.push(...areaReasons(facts, job, stage));
  }

  return uniqueReasons(reasons);
}

/**
 * The spatial check that needs I/O, kept separate because it geocodes.
 *
 * Rejects only when the location is confidently precise AND clearly outside
 * every polygon; anything coarse, not-found or unavailable falls through to the
 * LLM. A district centroid is the same point for a whole neighbourhood, so it
 * carries no evidence about which building this is.
 *
 * @returns {Promise<{code:string, stage:string}|null>}
 */
export async function areaReasonAsync(facts, job, stage) {
  const polygons = polygonsOf(job);
  if (!polygons.length) return null;

  const coords = facts.coords;
  if (coords?.precision === 'exact' && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
    return outside(polygons, coords.lat, coords.lng) ? { code: 'area_filter', stage } : null;
  }

  if (!facts.address) return null;
  const point = await geocodeAddress(facts.address);
  if (!point || !Number.isFinite(point.lat) || point.lat === -1) return null; // unavailable / not found
  const accuracy = getCachedAccuracy(SqliteConnection.getConnection(), addressKey, facts.address);
  if (!REJECTABLE_PRECISION.has(accuracy)) return null; // coarse → let the LLM decide
  return outside(polygons, point.lat, point.lng) ? { code: 'area_filter', stage } : null;
}

/** The first reason is the one shown; they are already in evidence order. */
export function primaryFilterReason(reasons) {
  return Array.isArray(reasons) && reasons.length ? reasons[0].code : null;
}

/* ---------------------------- stage adapters ---------------------------- */

/**
 * @deprecated in spirit — kept so callers can name their stage. Prefer
 * {@link collectFacts} + {@link filterReasons}.
 */
export function preLlmFilterReasons(discovery, job, deterministic) {
  return filterReasons(collectFacts({ discovery, deterministic }), job, 'pre_llm');
}

export function preLlmAreaReason(discovery, deterministic, job) {
  return areaReasonAsync(collectFacts({ discovery, deterministic }), job, 'pre_llm');
}

export function postLlmFilterReasons(listing, job) {
  return filterReasons(collectFacts({ listing }), job, 'post_llm');
}

/* -------------------------------- rules -------------------------------- */

/**
 * Evidence is checked field by field rather than as one blob so the reason can
 * name both the term and where it was found — an over-broad term then shows up
 * in the reason counts instead of hiding inside an undifferentiated total.
 *
 * The whole captured page is deliberately never evidence here. It carries
 * sidebars of similar ads and portal boilerplate, and it varies between captures
 * of the same ad, which made the verdict itself vary.
 */
function blacklistReasons(facts, terms, stage) {
  const evidence = [
    ['title', facts.title],
    ['description', facts.description],
    ['address', facts.address],
    ['detail_text', facts.detailText],
  ];
  for (const [field, value] of evidence) {
    if (!value) continue;
    const term = firstBlacklistMatch(String(value), terms);
    if (term) return [{ code: stage === 'post_llm' ? 'blacklist' : 'blacklist_pre_llm', stage, term, field }];
  }
  return [];
}

function specReasons(facts, specFilter, stage) {
  const reasons = [];
  const checks = [
    ['rooms', positiveNumber(facts.rooms), positiveNumber(specFilter?.minRooms), (a, r) => a < r],
    ['size', positiveNumber(facts.size), positiveNumber(specFilter?.minSize), (a, r) => a < r],
    ['price', positiveNumber(facts.price), positiveNumber(specFilter?.maxPrice), (a, r) => a > r],
  ];
  for (const [field, actual, required, fails] of checks) {
    if (required != null && actual != null && fails(actual, required)) {
      reasons.push({ code: 'spec_filter', stage, field, actual, required });
    }
  }
  return reasons;
}

function areaReasons(facts, job, stage) {
  const polygons = polygonsOf(job);
  if (!polygons.length) return [];
  const lat = Number(facts.latitude);
  const lng = Number(facts.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [{ code: 'no_coordinates', stage }];
  return outside(polygons, lat, lng) ? [{ code: 'area_filter', stage }] : [];
}

function polygonsOf(job) {
  return job?.spatialFilter?.features?.filter((feature) => feature.geometry?.type === 'Polygon') ?? [];
}

function outside(polygons, lat, lng) {
  return !polygons.some((polygon) => booleanPointInPolygon([lng, lat], polygon));
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
