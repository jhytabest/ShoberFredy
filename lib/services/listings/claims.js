/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { addressKey } from '../geocoding/address.js';
import { getCachedAccuracy } from '../geocoding/geocodeCache.js';
import { sha256 } from '../../shared/hash.js';
import { tableExists } from '../../shared/sqlite.js';
import { normalizeText, positiveNumber, unique } from '../../shared/values.js';
import { ACCEPTED_SQL } from '../pipeline/terminalVerdict.js';

const KIND_PRIORITY = ['cap', 'src', 'pid', 'url', 'sem', 'img', 'geo', 'tps'];

const IDENTITY_KINDS = new Set(['cap', 'src', 'pid', 'url']);

const TRUSTED_ACCURACIES = new Set(['house', 'street']);

const RELATIVE_BUCKET_RATIO = 1.03;

const SIZE_BUCKET_SQM = 0.5;

const COORD_CELL_DEGREES = 2.5e-4;

// Two different units live here, so both say so in the name. The *_RATIO
// values are fractions of the larger side; SIZE_SLACK_SQM is absolute square
// metres — 0.1 m², not 10%.
const PRICE_TOLERANCE_RATIO = { img: 0.02, geo: 0.05 };
const SIZE_TOLERANCE_RATIO = { geo: 0.05 };
const SIZE_SLACK_SQM = { img: 0.1, sem: 0.01 };

const MIN_SHARED_IMAGES = 2;

export function claimsForListing(listing) {
  if (!listing) return [];
  const claims = [];
  const add = (kind, value) => {
    if (value != null && value !== '') claims.push({ claim: `${kind}:${value}`, kind });
  };

  const captureHash = listing.captureHash ?? listing.hash ?? null;
  if (captureHash) add('cap', captureHash);

  const identities = (listing.sourceIdentities || []).filter((identity) => identity?.provider && identity?.sourceKey);

  const urls = unique([listing.link, ...(listing.sourceUrls || []), ...identities.map((i) => i.sourceUrl)]);
  for (const url of unique(urls.map(canonicalUrl))) add('url', url);
  for (const id of unique(urls.map(providerListingIdentity))) add('pid', id);
  for (const identity of identities) add('src', `${identity.provider}:${identity.sourceKey}`);

  for (const hash of unique(listing.imageHashes || [])) add('img', hash);

  const title = titleKey(listing.title);
  const price = positiveNumber(listing.price);
  const size = positiveNumber(listing.size);
  const address = String(listing.address || '').trim();
  const addressTokens = addressTokenKey(address);

  if (title && price != null) {
    for (const priceBucket of relativeBuckets(price)) {
      if (size != null) {
        for (const sizeBucket of sizeBuckets(size)) add('tps', `${digest(title)}|${priceBucket}|${sizeBucket}`);
      }
      if (addressTokens && /\d/u.test(address)) add('sem', `${digest(`${title}|${addressTokens}`)}|${priceBucket}`);
    }
  }

  const accuracy = listing.geocodeAccuracy ?? listing.geocode_accuracy ?? null;
  const lat = coordinate(listing.latitude, 90);
  const lng = coordinate(listing.longitude, 180);
  if (size != null && lat != null && lng != null && TRUSTED_ACCURACIES.has(accuracy)) {
    for (const latCell of cellBuckets(lat)) {
      for (const lngCell of cellBuckets(lng)) {
        for (const sizeBucket of relativeBuckets(size)) {
          add('geo', `${latCell}|${lngCell}|${sizeBucket}`);
        }
      }
    }
  }

  return dedupeClaims(claims);
}

export function resolveClaims(db, claims, { excludeListingId = null } = {}) {
  const keys = claimKeys(claims);
  if (!keys.length || !tableExists(db, 'listing_claims')) return [];
  return db
    .prepare(
      `SELECT claim, listing_id, source_id, kind
       FROM listing_claims
       WHERE claim IN (SELECT value FROM json_each(?))
         AND (? IS NULL OR listing_id IS NULL OR listing_id != ?)`,
    )
    .all(JSON.stringify(keys), excludeListingId, excludeListingId);
}

export function recordClaims(db, listingId, claims, now = Date.now()) {
  if (!listingId || !claims?.length || !tableExists(db, 'listing_claims')) return 0;
  const insert = db.prepare(
    `INSERT INTO listing_claims (claim, listing_id, source_id, kind, first_seen_at)
     VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT(claim) DO UPDATE SET listing_id = excluded.listing_id, source_id = NULL
     WHERE listing_claims.listing_id IS NULL`,
  );
  let inserted = 0;
  for (const { claim, kind } of dedupeClaims(claims)) {
    inserted += insert.run(claim, listingId, kind, now).changes;
  }
  return inserted;
}

export function recordSourceClaims(db, sourceId, claims, now = Date.now()) {
  if (!sourceId || !claims?.length || !tableExists(db, 'listing_claims')) return 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO listing_claims (claim, listing_id, source_id, kind, first_seen_at)
     VALUES (?, NULL, ?, ?, ?)`,
  );
  let inserted = 0;
  for (const { claim, kind } of dedupeClaims(claims)) {
    inserted += insert.run(claim, sourceId, kind, now).changes;
  }
  return inserted;
}

export function vetoes(left, right) {
  if (!left || !right) return 'missing-side';
  const kind = right.kind ?? left.kind ?? null;
  if (kind && IDENTITY_KINDS.has(kind)) return null;

  // German agency boilerplate titles repeat nationally, and street tokens
  // alone don't say which city they're in — so a heuristic claim (title,
  // image, geo-cell) can coincide across two cities even though the listings
  // it groups are not the same advert. An identity claim (cap/src/pid/url)
  // is real evidence of the same advert regardless of city and already
  // returned above; only the heuristic kinds need the market to agree.
  if (left.market && right.market && left.market !== right.market) return 'market-conflict';

  if (houseNumberConflict(left.address, right.address)) return 'house-number-conflict';
  if (roomsConflict(left, right)) return 'rooms-conflict';

  if (kind === 'img') {
    if (sharedImageCount(right) < MIN_SHARED_IMAGES) return 'single-shared-image';
    if (!withinRatio(left.price, right.price, PRICE_TOLERANCE_RATIO.img)) return 'price-conflict';
    if (!withinSqmOrUnknown(left.size, right.size, SIZE_SLACK_SQM.img)) return 'size-conflict';
  }
  if (kind === 'sem' || kind === 'tps') {
    if (titleKey(left.title) !== titleKey(right.title)) return 'title-conflict';
  }
  if (kind === 'sem') {
    if (addressTokenKey(left.address) !== addressTokenKey(right.address)) return 'address-conflict';
    if (!numbersEqual(left.price, right.price)) return 'price-conflict';
    if (!withinSqmOrUnknown(left.size, right.size, SIZE_SLACK_SQM.sem)) return 'size-conflict';
  }
  if (kind === 'tps') {
    if (!numbersEqual(left.price, right.price)) return 'price-conflict';
    if (!numbersEqual(left.size, right.size)) return 'size-conflict';
  }
  if (kind === 'geo') {
    if (!withinRatio(left.size, right.size, SIZE_TOLERANCE_RATIO.geo)) return 'size-conflict';
    if (comparableRents(left, right)) {
      if (!withinRatio(left.price, right.price, PRICE_TOLERANCE_RATIO.geo)) return 'price-conflict';
    } else if (!numbersEqual(left.rooms, right.rooms)) {
      return 'rooms-unconfirmed';
    }
    if (!addressesCompatible(left.address, right.address)) return 'address-conflict';
    if (!TRUSTED_ACCURACIES.has(accuracyOf(left)) || !TRUSTED_ACCURACIES.has(accuracyOf(right))) {
      return 'untrusted-geocode';
    }
  }
  return null;
}

export function resolveListingMatch(
  db,
  listing,
  { claims = null, excludeListingId = null, kinds = null, acceptedAnywhere = false } = {},
) {
  const asserted = claims || claimsForListing(listing);
  const matches = resolveClaims(db, asserted, { excludeListingId }).filter(
    (match) => match.listing_id && (!kinds || kinds.has(match.kind)),
  );
  if (!matches.length) return null;

  const byListing = new Map();
  for (const match of matches) {
    const entry = byListing.get(match.listing_id) || { kinds: new Map() };
    entry.kinds.set(match.kind, (entry.kinds.get(match.kind) || 0) + 1);
    if (!entry.claim || rank(match.kind) < rank(entry.kind)) {
      entry.kind = match.kind;
      entry.claim = match.claim;
    }
    byListing.set(match.listing_id, entry);
  }

  const mayMatchHidden = !acceptedAnywhere;
  const rows = hydrate(db, [...byListing.keys()]);
  const confirmed = [];
  for (const row of rows) {
    const entry = byListing.get(row.id);
    const hidden = !row.accepted;
    for (const kind of [...entry.kinds.keys()].sort((a, b) => rank(a) - rank(b))) {
      if (!IDENTITY_KINDS.has(kind) && hidden && !mayMatchHidden) continue;
      const candidate = { ...row, kind, sharedImages: entry.kinds.get('img') || 0 };
      if (vetoes(listing, candidate)) continue;
      confirmed.push({ listing: row, kind, claim: entry.claim, sharedImages: candidate.sharedImages });
      break;
    }
  }
  if (!confirmed.length) return null;
  confirmed.sort((a, b) => rank(a.kind) - rank(b.kind) || compareSurvivors(a.listing, b.listing));
  return { ...confirmed[0], claims: asserted };
}

export function compareSurvivors(left, right) {
  return (
    Number(!left.accepted) - Number(!right.accepted) ||
    Number(right.state === 'active') - Number(left.state === 'active') ||
    completeness(right) - completeness(left) ||
    Number(left.created_at || 0) - Number(right.created_at || 0) ||
    String(left.id).localeCompare(String(right.id))
  );
}

export function claimsFromDedupeKeys(keys) {
  const claims = [];
  for (const key of keys || []) {
    const value = String(key || '');
    if (value.startsWith('url:')) {
      const url = canonicalUrl(value.slice(4));
      if (url) claims.push({ claim: `url:${url}`, kind: 'url' });
      const providerId = providerListingIdentity(value.slice(4));
      if (providerId) claims.push({ claim: `pid:${providerId}`, kind: 'pid' });
    }
    const image = value.match(/^(?:card|evidence)-image:[0-9a-f]+:([0-9a-f]{16,})$/u);
    if (image) claims.push({ claim: `img:${image[1]}`, kind: 'img' });
  }
  return dedupeClaims(claims);
}

export function addressTokenKey(value) {
  const tokens = String(value || '')
    .toLocaleLowerCase('de-DE')
    .replace(/ß/gu, 'ss')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 || /^\d$/u.test(token));
  return [...new Set(tokens)].sort().join(' ');
}

export function addressesCompatible(left, right) {
  if (houseNumberConflict(left, right)) return false;
  const a = new Set(addressTokenKey(left).split(' ').filter(Boolean));
  const b = new Set(addressTokenKey(right).split(' ').filter(Boolean));
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (!large.has(token)) return false;
  return true;
}

export function houseNumbers(value) {
  const found = String(value || '').match(/\b\d{1,4}\s?[a-zA-Z]?\b/gu) || [];
  return new Set(found.map((token) => token.replace(/\s+/gu, '').toLowerCase()).filter(Boolean));
}

export function houseNumberConflict(left, right) {
  const a = houseNumbers(left);
  const b = houseNumbers(right);
  if (a.size === 0 || b.size === 0) return false;
  for (const token of a) if (b.has(token)) return false;
  return true;
}

export function discoveryDedupeKeys(listing) {
  const link = canonicalUrl(listing?.link);
  return link ? [`url:${link}`] : [];
}

export function detailDedupeKeys({ discovery, deterministic, images = [] }) {
  const keys = discoveryDedupeKeys(discovery);
  const card = strictEvidenceIdentity(discovery, null);
  const evidence = strictEvidenceIdentity(discovery, deterministic);
  for (const image of images) {
    if (!image?.contentHash) continue;
    if (card) keys.push(`card-image:${card}:${image.contentHash}`);
    if (evidence) keys.push(`evidence-image:${evidence}:${image.contentHash}`);
  }
  return unique(keys);
}

export function canonicalUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    if (/^(?:www\.)?immowelt\.de$/iu.test(url.hostname) && /\/expose\/[a-z0-9-]{8,}(?:\/|$)/iu.test(url.pathname)) {
      url.search = '';
      return url.toString().replace(/\/$/, '');
    }
    if (/^(?:www\.)?wg-gesucht\.de$/iu.test(url.hostname) && url.searchParams.has('asset_id')) {
      const assetId = url.searchParams.get('asset_id');
      url.search = '';
      url.searchParams.set('asset_id', assetId);
      return url.toString().replace(/\/$/, '');
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|ref|referrer|tracking|trackingId)$/iu.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value).trim();
  }
}

export function providerListingIdentity(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname;
    if (/(?:^|\.)immobilienscout24\.de$/u.test(host)) {
      const id = path.match(/\/expose\/(\d{6,})(?:\/|$)/u)?.[1];
      if (id) return `immoscout:${id}`;
    }
    if (/(?:^|\.)immowelt\.de$/u.test(host)) {
      const id = path.match(/\/expose\/([a-z0-9-]{8,})(?:\/|$)/iu)?.[1];
      if (id) return `immowelt:${id.toLowerCase()}`;
    }
    if (/(?:^|\.)wg-gesucht\.de$/u.test(host)) {
      const id = url.searchParams.get('asset_id') || path.match(/\.(\d{5,})\.html$/u)?.[1];
      if (id) return `wgGesucht:${id}`;
    }
    if (/(?:^|\.)kleinanzeigen\.de$/u.test(host)) {
      const id = path.match(/\/(\d+-\d+-\d+)(?:\/|$)/u)?.[1];
      if (id) return `kleinanzeigen:${id}`;
    }
  } catch {
    // Keep malformed historical URLs out of the provider-id kind.
  }
  return null;
}

export function geocodeAccuracyFor(db, address, city) {
  if (!tableExists(db, 'homeserver_geocode_cache')) return null;
  return getCachedAccuracy(db, addressKey, address, city);
}

function hydrate(db, listingIds) {
  if (!listingIds.length) return [];
  const rows = db
    .prepare(
      `SELECT l.*,
              json_extract(a.data, '$.priceType') AS price_basis,
              ${ACCEPTED_SQL('l')} AS accepted
       FROM listings l
       LEFT JOIN listing_attributes a ON a.listing_id = l.id
       WHERE l.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(listingIds));
  for (const row of rows) row.geocodeAccuracy = geocodeAccuracyFor(db, row.address, row.market);
  return rows;
}

function rank(kind) {
  const index = KIND_PRIORITY.indexOf(kind);
  return index === -1 ? KIND_PRIORITY.length : index;
}

function claimKeys(claims) {
  return unique((claims || []).map((entry) => (typeof entry === 'string' ? entry : entry?.claim)));
}

function dedupeClaims(claims) {
  const seen = new Set();
  const out = [];
  for (const entry of claims) {
    if (!entry?.claim || seen.has(entry.claim)) continue;
    seen.add(entry.claim);
    out.push({ claim: entry.claim, kind: entry.kind });
  }
  return out;
}

function digest(value) {
  return sha256(value).slice(0, 16);
}

function titleKey(value) {
  return normalizeText(value)
    .replace(/[.,;]+$/u, '')
    .replace(/\|/gu, ' ')
    .trim();
}

function relativeBuckets(value) {
  const bucket = Math.floor(Math.log(value) / Math.log(RELATIVE_BUCKET_RATIO));
  return [bucket, bucket - 1];
}

function sizeBuckets(size) {
  const bucket = Math.floor(size / SIZE_BUCKET_SQM);
  return [bucket, bucket - 1];
}

function cellBuckets(value) {
  const bucket = Math.floor(value / COORD_CELL_DEGREES);
  return [bucket, bucket - 1];
}

function coordinate(value, limit) {
  const parsed = Number(value);
  if (value == null || !Number.isFinite(parsed)) return null;
  if (parsed === -1 || Math.abs(parsed) > limit) return null;
  return parsed === 0 ? null : parsed;
}

function accuracyOf(side) {
  return side?.geocodeAccuracy ?? side?.geocode_accuracy ?? null;
}

function priceBasisOf(side) {
  const basis = side?.priceType ?? side?.attributes?.priceType ?? side?.price_basis ?? null;
  return basis === 'cold' || basis === 'warm' ? basis : null;
}

function comparableRents(left, right) {
  const a = priceBasisOf(left);
  return a != null && a === priceBasisOf(right);
}

function sharedImageCount(candidate) {
  return Number(candidate?.sharedImages ?? candidate?.shared_images ?? 0);
}

function roomsConflict(left, right) {
  const a = positiveNumber(left?.rooms);
  const b = positiveNumber(right?.rooms);
  if (a == null || b == null) return false;
  return Math.abs(a - b) > 0.01;
}

// Three comparisons with two deliberately different missing-value policies.
// `OrUnknown` says so in the name: a size nobody stated is not evidence of a
// conflict, so it passes. The other two demand both sides before they will
// agree, because a claim kind that leans on price equality must not be
// satisfied by silence.
function withinSqmOrUnknown(left, right, slackSqm) {
  const a = positiveNumber(left);
  const b = positiveNumber(right);
  if (a == null || b == null) return true;
  return Math.abs(a - b) <= slackSqm;
}

function numbersEqual(left, right) {
  const a = positiveNumber(left);
  const b = positiveNumber(right);
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 0.01;
}

function withinRatio(left, right, ratio) {
  const a = positiveNumber(left);
  const b = positiveNumber(right);
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= ratio * Math.max(a, b);
}

function completeness(listing) {
  return ['title', 'address', 'price', 'size', 'rooms'].reduce(
    (total, key) => total + Number(listing[key] != null && listing[key] !== ''),
    0,
  );
}

function strictEvidenceIdentity(discovery, deterministic) {
  const trusted = (field, fallback) =>
    field && ['high', 'medium'].includes(field.confidence) && field.value != null ? field.value : fallback;
  const address = normalizeText(trusted(deterministic?.address, discovery?.address));
  const price = positiveNumber(trusted(deterministic?.price, discovery?.price));
  const size = positiveNumber(trusted(deterministic?.size, discovery?.size));
  const rooms = positiveNumber(trusted(deterministic?.rooms, discovery?.rooms));
  if (!address || !/\d/u.test(address) || price == null || size == null || rooms == null) return null;
  return sha256(`${address}|${price}|${size}|${rooms}`);
}
