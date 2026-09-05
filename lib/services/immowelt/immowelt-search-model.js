/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export const IMMOWELT_SEARCH_PATH = '/classified-search';

export const DEFAULT_PAGE_SIZE = 100;

export const DEFAULT_ORDER = 'DateDesc';

const LIST_PARAMS = [
  'distributionTypes',
  'estateTypes',
  'estateSubTypes',
  'projectTypes',
  'featuresIncluded',
  'furnished',
  'useFor',
  'buildState',
  'energyTypes',
  'energyCertificateClass',
  'locationsInBuildingIncluded',
  'locationsInBuildingExcluded',
];

const NUMBER_PARAMS = [
  'priceMin',
  'priceMax',
  'numberOfRoomsMin',
  'numberOfRoomsMax',
  'spaceMin',
  'spaceMax',
  'yearOfConstructionMin',
  'yearOfConstructionMax',
  'plotSpaceMin',
  'plotSpaceMax',
  'numberOfBedroomsMin',
  'numberOfBedroomsMax',
];

const ENUM_PARAMS = ['classifiedBusiness', 'priceType'];

const VERBATIM_ENUM_PARAMS = ['certificateOfEligibilityNeeded'];

const BOOLEAN_PARAMS = ['isSaleGoodwill', 'availableFromIsLooseMode'];

const DATE_PARAMS = ['availableFromMax'];

const UNTRANSLATABLE_PARAMS = ['keywords', 'listingsDisplay', 'deliveryTimeline'];

const PAGING_PARAMS = ['order', 'page'];

const NOISE_PARAMS = new Set(['m', 'sr', 'cp', 'sp', 'serp_view', 'search', 'redirect', 'dispatchModal', 'ln']);

function toPascalCase(value) {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}

function toList(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function decodeLocationEntry(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const json = Buffer.from(base64 + '='.repeat((4 - (base64.length % 4)) % 4), 'base64').toString('utf8');
  if (!json.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(json);
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const ENCODED_LOCATION_KEYS = new Set(['drawings', 'polylines', 'polyline', 'placeIds', 'placeId']);

const ENCODED_BOUNDARY_COMPANIONS = new Set(['radius', 'coordinates']);

const ENCODED_COMMUTE_KEYS = new Set(['duration', 'mode']);

const COMMUTE_MODES = new Set(['walk', 'bike', 'car', 'transit']);

function toStringList(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map((entry) => String(entry).trim()).filter(Boolean);
}

function parseLocations(raw, searchUrl) {
  const entries = toList(raw ?? '');
  if (entries.length === 0) {
    throw new Error(
      `Immowelt search url carries no 'locations' parameter, so there is nothing to search in: ${searchUrl}`,
    );
  }

  const placeIds = [];

  const polylines = [];

  const commutes = [];

  for (const entry of entries) {
    const decoded = decodeLocationEntry(entry);
    if (decoded == null) {
      placeIds.push(entry);
      continue;
    }

    const unsupported = Object.keys(decoded).filter(
      (key) =>
        !ENCODED_LOCATION_KEYS.has(key) && !ENCODED_BOUNDARY_COMPANIONS.has(key) && !ENCODED_COMMUTE_KEYS.has(key),
    );
    if (unsupported.length > 0) {
      throw new Error(
        `Immowelt search url describes its search area with ${unsupported.join(', ')}, which Fredy cannot ` +
          `translate yet. Searching without it would cover a different area than the one you saved, so the job ` +
          `stops instead. Please open an issue with this url so it can be added: ${searchUrl}`,
      );
    }

    const boundary = [
      ...toStringList(decoded.drawings),
      ...toStringList(decoded.polylines),
      ...toStringList(decoded.polyline),
    ];
    if (boundary.length > 0) {
      polylines.push(...boundary);
      continue;
    }

    if (Object.keys(decoded).some((key) => ENCODED_COMMUTE_KEYS.has(key))) {
      commutes.push(parseCommute(decoded, searchUrl));
      continue;
    }

    const companions = Object.keys(decoded).filter((key) => ENCODED_BOUNDARY_COMPANIONS.has(key));
    if (companions.length > 0) {
      throw new Error(
        `Immowelt search url saves its search area as ${companions.join(', ')} without the boundary Fredy needs ` +
          `to reproduce it. Searching the whole place instead would cover a wider area than the one you saved, so ` +
          `the job stops instead. Url: ${searchUrl}`,
      );
    }

    placeIds.push(...toStringList(decoded.placeIds), ...toStringList(decoded.placeId));
  }

  if (polylines.length > 0 || commutes.length > 0) {
    return { location: polylines.length > 0 ? { polylines } : {}, commutes };
  }

  if (placeIds.length === 0) {
    throw new Error(
      `Immowelt search url carries an empty 'locations' parameter, so there is nothing to search in: ${searchUrl}`,
    );
  }

  return { location: { placeIds }, commutes };
}

function parseCommute(decoded, searchUrl) {
  const places = [...toStringList(decoded.placeIds), ...toStringList(decoded.placeId)];
  const duration = Number(decoded.duration);
  const mode = String(decoded.mode ?? '').trim();

  if (places.length !== 1) {
    throw new Error(
      `Immowelt search url describes a commute area around ${places.length} places, and Fredy can only travel ` +
        `from exactly one. Url: ${searchUrl}`,
    );
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(
      `Immowelt search url describes a commute area of '${decoded.duration}' minutes, which is not a travel time ` +
        `Fredy can ask for. Url: ${searchUrl}`,
    );
  }

  if (!COMMUTE_MODES.has(mode.toLowerCase())) {
    throw new Error(
      `Immowelt search url describes a commute area travelled by '${decoded.mode}', which Fredy cannot translate ` +
        `yet (it knows ${[...COMMUTE_MODES].join(', ')}). Please open an issue with this url so it can be added: ` +
        `${searchUrl}`,
    );
  }

  return { placeId: places[0], duration, mode };
}

function parseBoundingBox(raw, searchUrl) {
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const corners = decoded.split(',').map(Number);

  if (corners.length !== 4 || corners.some((value) => !Number.isFinite(value))) {
    throw new Error(
      `Immowelt search url carries a map section ('bbox') Fredy cannot read: '${decoded}'. Searching without it ` +
        `would cover a wider area than the map you saved, so the job stops instead. Url: ${searchUrl}`,
    );
  }

  const [minLon, minLat, maxLon, maxLat] = corners;
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ],
    ],
  };
}

export function convertSearchUrlToRequest(searchUrl, { size = DEFAULT_PAGE_SIZE } = {}) {
  const params = new URL(searchUrl).searchParams;

  const criteria = {};

  for (const name of LIST_PARAMS) {
    const raw = params.get(name);
    if (raw == null) continue;
    const values = toList(raw);
    if (values.length > 0) criteria[name] = values;
  }

  for (const name of NUMBER_PARAMS) {
    const raw = params.get(name);
    if (raw == null || raw.trim() === '') continue;
    const value = Number(raw);

    if (!Number.isFinite(value)) {
      throw new Error(
        `Immowelt search parameter '${name}' is '${raw}', which is not a number. Searching without it would ` +
          `ignore a limit you set, so the job stops instead. Url: ${searchUrl}`,
      );
    }
    criteria[name] = value;
  }

  for (const name of ENUM_PARAMS) {
    const raw = params.get(name);
    if (raw == null || raw.trim() === '') continue;
    criteria[name] = toPascalCase(raw.trim());
  }

  for (const name of VERBATIM_ENUM_PARAMS) {
    const raw = params.get(name);
    if (raw == null || raw.trim() === '') continue;
    criteria[name] = raw.trim();
  }

  for (const name of BOOLEAN_PARAMS) {
    const raw = params.get(name);
    if (raw == null || raw.trim() === '') continue;
    const value = raw.trim().toLowerCase();

    if (value !== 'true' && value !== 'false') {
      throw new Error(
        `Immowelt search parameter '${name}' is '${raw}', which is neither true nor false. Url: ${searchUrl}`,
      );
    }
    criteria[name] = value === 'true';
  }

  for (const name of DATE_PARAMS) {
    const raw = params.get(name);
    if (raw == null || raw.trim() === '') continue;
    const value = raw.trim();
    if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value)) {
      throw new Error(
        `Immowelt search parameter '${name}' is '${raw}', which is not a date the BFF accepts ` +
          `(YYYY-MM-DD). Url: ${searchUrl}`,
      );
    }
    criteria[name] = value;
  }

  const { location, commutes } = parseLocations(params.get('locations'), searchUrl);
  criteria.location = location;

  const bbox = params.get('bbox');
  if (bbox != null && bbox.trim() !== '') {
    criteria.location.geometry = parseBoundingBox(bbox.trim(), searchUrl);
  }

  const page = Number(params.get('page') ?? 1);
  const paging = {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    size,
    order: params.get('order') || DEFAULT_ORDER,
  };

  rejectUnhandledParams(params, searchUrl);

  return { criteria, paging, commutes };
}

export function isochroneToPolylines(isochrone) {
  return (isochrone || []).flatMap((polygon) => (polygon || []).map((ring) => encodePolyline(ring)));
}

export function encodePolyline(ring) {
  let previousLat = 0;
  let previousLng = 0;
  let encoded = '';

  for (const [lng, lat] of ring || []) {
    const scaledLat = Math.round(lat * 1e5);
    const scaledLng = Math.round(lng * 1e5);
    encoded += encodeSignedNumber(scaledLat - previousLat) + encodeSignedNumber(scaledLng - previousLng);
    previousLat = scaledLat;
    previousLng = scaledLng;
  }

  return encoded;
}

function encodeSignedNumber(value) {
  let remaining = value < 0 ? ~(value << 1) : value << 1;
  let encoded = '';

  while (remaining >= 0x20) {
    encoded += String.fromCharCode((0x20 | (remaining & 0x1f)) + 63);
    remaining >>= 5;
  }

  return encoded + String.fromCharCode(remaining + 63);
}

function rejectUnhandledParams(params, searchUrl) {
  const handled = new Set([
    ...LIST_PARAMS,
    ...NUMBER_PARAMS,
    ...ENUM_PARAMS,
    ...VERBATIM_ENUM_PARAMS,
    ...BOOLEAN_PARAMS,
    ...DATE_PARAMS,
    ...PAGING_PARAMS,
    'locations',
    'bbox',
  ]);

  const unhandled = [...new Set(params.keys())].filter(
    (name) => !handled.has(name) && !NOISE_PARAMS.has(name) && !name.startsWith('utm_'),
  );

  if (unhandled.length > 0) {
    const ignoredByTheBff = unhandled.filter((name) => UNTRANSLATABLE_PARAMS.includes(name));
    const hint =
      ignoredByTheBff.length > 0
        ? ` The search BFF has no field for ${ignoredByTheBff.join(', ')} at all, so this url cannot be searched ` +
          `through the api - rebuild it in immowelt's filter panel without them.`
        : '';

    throw new Error(
      `Immowelt search url uses filter(s) Fredy cannot translate yet: ${unhandled.join(', ')}.${hint} Ignoring them would ` +
        `run a wider search than the one in your browser and notify you about listings you filtered out, so the job ` +
        `stops instead. Remove those filters from the url, or open an issue so they get translated. Url: ${searchUrl}`,
    );
  }
}
