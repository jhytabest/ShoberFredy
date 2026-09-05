/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getProviders } from '../../utils.js';
import { INTENT_CODES, specFilterProblems } from '../pipeline/listingFilters.js';

// A job is only ever written through here. Every field it carries is read by
// something at a specific stage, and a filter the pipeline cannot read is worse
// than no filter at all: the search silently keeps running without it.

export class JobDocumentError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'JobDocumentError';
    this.problems = problems;
  }
}

const FIELDS = new Set([
  'enabled',
  'name',
  'city',
  'interval',
  'workingHours',
  'blacklist',
  'intentFilter',
  'provider',
  'notify',
  'spatialFilter',
  'specFilter',
]);

// A new job needs the parts without which it cannot do anything: somewhere to
// search, somewhere to report, a city to price against, and a cadence of its
// own — there is no deployment-wide default left to fall back on. A patch
// does not need all of this; it is judged only on what it changes.
const REQUIRED_FOR_NEW = ['name', 'city', 'provider', 'notify', 'interval'];

export async function validateJobDocument(document, { partial = false } = {}) {
  const problems = [];
  if (document == null || typeof document !== 'object' || Array.isArray(document)) {
    throw new JobDocumentError(['A job must be a JSON object']);
  }

  for (const key of Object.keys(document)) {
    if (!FIELDS.has(key)) problems.push(`Unknown job field '${key}'`);
  }
  if (!partial) {
    for (const key of REQUIRED_FOR_NEW) {
      if (!(key in document)) problems.push(`A new job needs '${key}'`);
    }
  }

  if ('name' in document && !nonEmptyString(document.name)) problems.push(`'name' must be a non-empty string`);
  if ('city' in document && !nonEmptyString(document.city)) problems.push(`'city' must be a non-empty string`);
  if ('enabled' in document && typeof document.enabled !== 'boolean') problems.push(`'enabled' must be true or false`);

  if ('interval' in document) problems.push(...intervalProblems(document.interval));
  if ('workingHours' in document) problems.push(...workingHoursProblems(document.workingHours));
  if ('blacklist' in document) problems.push(...blacklistProblems(document.blacklist));
  if ('intentFilter' in document) problems.push(...intentProblems(document.intentFilter));
  if ('provider' in document) problems.push(...(await providerProblems(document.provider)));
  if ('notify' in document) problems.push(...notifyProblems(document.notify));
  if ('specFilter' in document) problems.push(...specProblems(document.specFilter));
  if ('spatialFilter' in document) problems.push(...spatialProblems(document.spatialFilter));

  if (problems.length) throw new JobDocumentError(problems);
  return document;
}

function blacklistProblems(blacklist) {
  if (!Array.isArray(blacklist)) return [`'blacklist' must be an array of terms`];
  return blacklist.every((term) => nonEmptyString(term)) ? [] : [`'blacklist' terms must be non-empty strings`];
}

function intentProblems(intents) {
  if (!Array.isArray(intents)) return [`'intentFilter' must be an array of intent codes`];
  const unknown = intents.filter((intent) => !INTENT_CODES.includes(intent));
  if (!unknown.length) return [];
  return [`Unknown intent code(s) ${unknown.map((i) => `'${i}'`).join(', ')}. Known: ${INTENT_CODES.join(', ')}`];
}

async function providerProblems(provider) {
  if (!Array.isArray(provider) || provider.length === 0) {
    return [`'provider' must be a non-empty array of { id, url } entries`];
  }
  const loaded = await getProviders();
  const known = loaded.map((module) => module.metaInformation.id);
  const problems = [];
  for (const [index, entry] of provider.entries()) {
    const at = `provider[${index}]`;
    if (entry == null || typeof entry !== 'object') {
      problems.push(`${at} must be an object`);
      continue;
    }
    if (!known.includes(entry.id)) {
      problems.push(`${at}.id '${entry.id}' is not a provider. Known: ${known.join(', ')}`);
    }
    if (!httpUrl(entry.url)) problems.push(`${at}.url must be an http(s) URL`);
    if ('maxPages' in entry && entry.maxPages != null) {
      if (!(Number.isInteger(entry.maxPages) && entry.maxPages > 0)) {
        problems.push(`${at}.maxPages must be a positive integer`);
      }
    }
  }
  return problems;
}

function intervalProblems(interval) {
  return Number.isInteger(interval) && interval > 0 ? [] : [`'interval' must be a positive integer (minutes)`];
}

function workingHoursProblems(workingHours) {
  if (workingHours == null) return [];
  if (typeof workingHours !== 'object' || Array.isArray(workingHours)) {
    return [`'workingHours' must be an object with 'from' and 'to'`];
  }
  const problems = [];
  for (const key of ['from', 'to']) {
    if (key in workingHours && workingHours[key] != null && typeof workingHours[key] !== 'string') {
      problems.push(`workingHours.${key} must be a string (e.g. '08:00') or empty`);
    }
  }
  return problems;
}

function notifyProblems(notify) {
  if (notify == null || typeof notify !== 'object' || Array.isArray(notify)) {
    return [`'notify' must be an object with 'token' and 'chatId'; a job nobody hears from does nothing`];
  }
  const problems = [];
  if (!nonEmptyString(notify.token)) problems.push(`notify.token must be a non-empty string`);
  if (!nonEmptyString(notify.chatId) && !Number.isInteger(notify.chatId)) {
    problems.push(`notify.chatId must be a chat id, or several separated by commas`);
  }
  if ('threadId' in notify && notify.threadId != null) {
    const thread = Number(notify.threadId);
    if (!Number.isInteger(thread) || thread <= 0) {
      problems.push(`notify.threadId must be a positive integer`);
    }
  }
  if ('plainText' in notify && typeof notify.plainText !== 'boolean') {
    problems.push(`notify.plainText must be true or false`);
  }
  return problems;
}

const specProblems = specFilterProblems;

function spatialProblems(spatial) {
  if (spatial == null) return [];
  if (typeof spatial !== 'object' || Array.isArray(spatial)) {
    return [`'spatialFilter' must be a GeoJSON FeatureCollection or null`];
  }
  if (spatial.type !== 'FeatureCollection' || !Array.isArray(spatial.features)) {
    return [`'spatialFilter' must be a GeoJSON FeatureCollection`];
  }
  // Only polygons are consulted, so a collection carrying none would be a
  // filter that silently accepts everywhere.
  const polygons = spatial.features.filter((feature) => feature?.geometry?.type === 'Polygon');
  if (!polygons.length) {
    return [`'spatialFilter' carries no Polygon feature; pass null for a search with no area limit`];
  }
  const validPoint = (point) =>
    Array.isArray(point) &&
    point.length >= 2 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    Math.abs(point[0]) <= 180 &&
    Math.abs(point[1]) <= 90;
  const validRing = (ring) =>
    Array.isArray(ring) &&
    ring.length >= 4 &&
    ring.every(validPoint) &&
    ring[0][0] === ring.at(-1)[0] &&
    ring[0][1] === ring.at(-1)[1];
  return polygons.every(
    (polygon) =>
      Array.isArray(polygon.geometry.coordinates) &&
      polygon.geometry.coordinates.length > 0 &&
      polygon.geometry.coordinates.every(validRing),
  )
    ? []
    : ["'spatialFilter' polygons need closed rings of at least four valid [longitude, latitude] points"];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function httpUrl(value) {
  if (!nonEmptyString(value)) return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function berlinRentalJob(document) {
  return {
    ...document,
    city: 'Berlin',
    interval: document.interval ?? 15,
    workingHours: document.workingHours ?? { from: '', to: '' },
    blacklist: document.blacklist ?? [],
    intentFilter: document.intentFilter ?? ['swap', 'wg_room', 'sublet', 'furnished', 'fixed_term'],
    specFilter: {
      minSize: 60,
      minFloor: 3,
      maxPrice: 2500,
      priceBasis: 'cold',
      offerKinds: ['rental'],
      unitKinds: ['entire_home'],
      leaseDurations: ['indefinite', 'unstated'],
      furnishingStatuses: ['none', 'partial'],
      conditions: ['well_maintained', 'renovated', 'refurbished', 'like_new', 'first_occupancy_after_renovation'],
      requiredAmenities: ['old_building'],
      ...document.specFilter,
    },
    spatialFilter: document.spatialFilter,
  };
}
