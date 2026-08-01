/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { firstBlacklistMatch } from '../../utils.js';
import { intentFilterReasons } from './listingIntent.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { addressKey } from '../geocoding/address.js';
import { getCachedAccuracy } from '../geocoding/geocodeCache.js';
import { geocodeAddress } from '../geocoding/geoCodingService.js';
import { env } from '../../shared/env.js';
import { positiveNumber } from '../../shared/values.js';
import { CanonicalFacts, CardFacts, GeoFacts, assertFacts } from './stageFacts.js';

/**
 * Three rule sets, one per stage, over three shapes that share no field name.
 *
 * There used to be one rule set over one merged fact object, applied at every
 * stage. That was meant to guarantee the verdict depended only on the evidence,
 * but it produced the opposite: because the same rules ran three times over a
 * fallback chain, a listing was blacklisted on card text, then blacklisted again
 * on page text, then blacklisted a third time on the extraction — and the second
 * of those was worthless. Over a week the detail-stage text and specification
 * checks rejected 215 adverts *after* paying the page fetch they were supposed
 * to avoid, while the geographic check beside them rejected 855.
 *
 * So the stages now differ by design, and each is the cheapest question that
 * stage can usefully ask:
 *
 *   card        a simple, safe blacklist and the specification. Free — no
 *               request has been made yet. Must only reject on what the card
 *               plainly states.
 *   detail      geography, and nothing else. The page must be fetched for
 *               extraction regardless, so this check is free too; it is kept
 *               because it is the only one that pays for itself.
 *   extraction  structured fields only, plus one geographic check re-derived
 *               from the canonical address.
 *
 * There is deliberately no text matching after the LLM. Asking a language model
 * whether an advert offers a sublet and then also grepping the page for
 * "Untermiete" is asking twice and believing the worse answer — the same
 * wg-gesucht advert was filtered on one run and passed on the next purely
 * because the second capture carried a different amount of page text.
 *
 * The pre-extraction asymmetry is unchanged and load-bearing: a rule may reject
 * early only on evidence it is confident about, and must otherwise fall through.
 * Rejecting a flat that would have passed costs the flat; spending an LLM call
 * on one that would have failed costs a fraction of a cent.
 */

/** Geocode precisions confident enough to reject a listing before the LLM. */
const REJECTABLE_PRECISION = new Set(
  String(env('FREDY_PRELLM_AREA_MIN_PRECISION'))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

/**
 * The card stage. Free to run, so it runs on every sighting.
 *
 * The blacklist is the full configured list here, matched against the card's own
 * text. That is the "simple and safe" half of the split: portal names and
 * unambiguous phrases are exactly what a card states plainly, and the matcher
 * already refuses the traps that make substring matching wrong in German —
 * `möbliert` does not fire on `unmöbliert`, `Tausch` does not fire on
 * `Austausch`, `WG` matches only as a whole token and not inside `Wegweiser`.
 *
 * @param {CardFacts} facts
 * @param {object} job
 * @returns {{code: string, stage: string, term?: string, field?: string}[]}
 */
export function cardFilterReasons(facts, job) {
  assertFacts(facts, CardFacts, 'cardFilterReasons');
  const reasons = [];
  const evidence = [
    ['title', facts.cardTitle],
    ['description', facts.cardDescription],
    ['address', facts.cardAddress],
  ];
  for (const [field, value] of evidence) {
    if (!value) continue;
    const term = firstBlacklistMatch(String(value), job?.blacklist || []);
    if (term) {
      reasons.push({ code: 'blacklist', stage: 'discovery', term, field });
      break;
    }
  }
  reasons.push(
    ...specReasons(
      { price: facts.cardPrice, size: facts.cardSize, rooms: facts.cardRooms },
      job?.specFilter,
      'discovery',
    ),
  );
  return reasons;
}

/**
 * The detail stage. One question: is it even in the right place?
 *
 * Rejects only when the geocode is precise enough to name a building AND the
 * point falls outside every interested job's polygons. A district centroid is
 * the same point for a whole neighbourhood, so it carries no evidence about
 * which building this is, and anything coarse, not found or unavailable falls
 * through to the LLM.
 *
 * The union over jobs is the point of doing the work once: an advert wanted by
 * any job must survive to extraction, and per-job geography is settled again
 * afterwards from the canonical address.
 *
 * @param {GeoFacts} facts
 * @param {object[]} jobs every job that is interested in this advert
 * @returns {Promise<{code: string, stage: string}|null>}
 */
export async function geoRejectReason(facts, jobs) {
  assertFacts(facts, GeoFacts, 'geoRejectReason');
  const polygonSets = (jobs || []).map(polygonsOf).filter((polygons) => polygons.length);
  // A job with no polygon accepts everywhere, which makes the union everywhere.
  if (!polygonSets.length || polygonSets.length !== (jobs || []).length) return null;

  const point = await confidentPoint(facts);
  if (!point) return null;
  const insideSomewhere = polygonSets.some((polygons) => !outside(polygons, point.lat, point.lng));
  return insideSomewhere ? null : { code: 'area', stage: 'detail' };
}

/**
 * The extraction stage. Structured fields, and geography re-derived from the
 * canonical address.
 *
 * @param {CanonicalFacts} facts
 * @param {object} job
 * @returns {{code: string, stage: string}[]}
 */
export function canonicalFilterReasons(facts, job) {
  assertFacts(facts, CanonicalFacts, 'canonicalFilterReasons');
  const reasons = [];

  // The authoritative layer: the model read the whole page and answered "is this
  // a swap / sublet / WG room / furnished / fixed-term?" as validated enum
  // fields. Ask those instead of hunting for the words that imply them.
  reasons.push(...intentFilterReasons(facts.canonicalAttributes, job?.blacklist || []));

  reasons.push(
    ...specReasons(
      { price: facts.canonicalPrice, size: facts.canonicalSize, rooms: facts.canonicalRooms },
      job?.specFilter,
      'extraction',
    ),
  );

  // A listing with no rent cannot be judged: it escapes maxPrice, it cannot be
  // scored against the market model, and it is not actionable — you cannot
  // decide about a flat whose price nobody has stated. The model has read the
  // whole page by now, so a still-missing price means the advert names none.
  if (facts.canonicalPrice == null) reasons.push({ code: 'no_price', stage: 'extraction' });

  reasons.push(...canonicalAreaReasons(facts, job));
  return uniqueReasons(reasons);
}

/**
 * Coordinates for the canonical address, resolved now rather than inherited.
 *
 * The pre-extraction geocode was performed on an address scraped out of the
 * page, and reusing it let a coarse district centroid decide a listing the model
 * had since given a house number for. `geocodeAddress` answers from the cache
 * first, so re-asking costs nothing when the address has not changed.
 *
 * @param {string|null} address canonical address
 * @returns {Promise<{lat: number, lng: number}|null>}
 */
export async function canonicalCoordinates(address) {
  if (!address) return null;
  const point = await geocodeAddress(address);
  if (!point || !Number.isFinite(point.lat) || point.lat === -1) return null;
  return { lat: point.lat, lng: point.lng };
}

/** The first reason is the one shown; they are already in evidence order. */
export function primaryFilterReason(reasons) {
  return Array.isArray(reasons) && reasons.length ? reasons[0].code : null;
}

/** The stage that produced the reason shown, for the verdict row. */
export function primaryFilterStage(reasons) {
  return Array.isArray(reasons) && reasons.length ? reasons[0].stage : null;
}

/* -------------------------------- rules ---------------------------------- */

/**
 * A point precise enough to reject on, or null.
 *
 * Structured coordinates the provider published for an exact address are taken
 * as given. Otherwise the stated address is geocoded and the answer is used only
 * when the geocoder says it resolved to a building or a street.
 */
async function confidentPoint(facts) {
  if (facts.geoPrecision === 'exact' && facts.geoLat != null && facts.geoLng != null) {
    return { lat: facts.geoLat, lng: facts.geoLng };
  }
  if (!facts.geoAddress) return null;
  const point = await geocodeAddress(facts.geoAddress);
  if (!point || !Number.isFinite(point.lat) || point.lat === -1) return null;
  const accuracy = getCachedAccuracy(SqliteConnection.getConnection(), addressKey, facts.geoAddress);
  if (!REJECTABLE_PRECISION.has(accuracy)) return null;
  return { lat: point.lat, lng: point.lng };
}

function specReasons(values, specFilter, stage) {
  const reasons = [];
  const checks = [
    ['rooms', positiveNumber(values.rooms), positiveNumber(specFilter?.minRooms), (a, r) => a < r],
    ['size', positiveNumber(values.size), positiveNumber(specFilter?.minSize), (a, r) => a > 0 && a < r],
    ['price', positiveNumber(values.price), positiveNumber(specFilter?.maxPrice), (a, r) => a > r],
  ];
  for (const [field, actual, required, fails] of checks) {
    if (required != null && actual != null && fails(actual, required)) {
      reasons.push({ code: 'spec', stage, field, actual, required });
    }
  }
  return reasons;
}

function canonicalAreaReasons(facts, job) {
  const polygons = polygonsOf(job);
  if (!polygons.length) return [];
  if (facts.canonicalLat == null || facts.canonicalLng == null) {
    return [{ code: 'no_coordinates', stage: 'extraction' }];
  }
  return outside(polygons, facts.canonicalLat, facts.canonicalLng) ? [{ code: 'area', stage: 'extraction' }] : [];
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
