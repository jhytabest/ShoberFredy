/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { addressKey } from '../geocoding/address.js';
import { getCachedAccuracy } from '../geocoding/geocodeCache.js';
import { tableExists } from '../../shared/sqlite.js';
import { positiveNumber, unique } from '../../shared/values.js';

const KIND_PRIORITY = ['src', 'pid', 'url', 'img'];
const IDENTITY_KINDS = new Set(['src', 'pid', 'url']);

export function claimsForListing(listing) {
  if (!listing) return [];
  const claims = [];
  const add = (kind, value) => { if (value) claims.push({ claim: `${kind}:${value}`, kind }); };
  const identities = listing.sourceIdentities ?? [];
  const urls = unique([listing.link, ...(listing.sourceUrls ?? []), ...identities.map((i) => i.sourceUrl)]);
  for (const url of unique(urls.map(canonicalUrl))) add('url', url);
  for (const id of unique(urls.map(providerListingIdentity))) add('pid', id);
  for (const i of identities) if (i.provider && i.sourceKey) add('src', `${i.provider}:${i.sourceKey}`);
  for (const hash of unique(listing.imageHashes ?? [])) add('img', hash);
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

export function vetoes(left, right) {
  if (!left || !right) return 'missing-side';
  if (IDENTITY_KINDS.has(right.kind)) return null;
  if (right.kind !== 'img') return 'unsupported-match';
  if (left.market && right.market && left.market !== right.market) return 'market-conflict';
  if (houseNumberConflict(left.address, right.address)) return 'address-conflict';
  if (left.address && right.address && !addressesCompatible(left.address, right.address)) return 'address-conflict';
  const a = positiveNumber(left.rooms), b = positiveNumber(right.rooms);
  if (a != null && b != null && Math.abs(a - b) > 0.01) return 'rooms-conflict';
  const floor = left.attributes?.floor ?? left.floor;
  if (floor != null && right.floor != null && floor !== right.floor) return 'floor-conflict';
  if (Number(right.sharedImages || 0) < 2) return 'single-shared-image';
  const sizeA = positiveNumber(left.size), sizeB = positiveNumber(right.size);
  if (sizeA == null || sizeB == null || Math.abs(sizeA - sizeB) > Math.min(1, Math.max(sizeA, sizeB) * 0.01)) return 'size-conflict';
  const basisA = left.attributes?.priceType ?? left.price_basis;
  if (['cold', 'warm'].includes(basisA) && basisA === right.price_basis) {
    const priceA = positiveNumber(left.price), priceB = positiveNumber(right.price);
    if (priceA != null && priceB != null && Math.abs(priceA - priceB) > Math.max(priceA, priceB) * 0.05) return 'price-conflict';
  }
  return null;
}

export function resolveListingMatch(
  db,
  listing,
  { claims = null, excludeListingId = null, kinds = null } = {},
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

  const rows = hydrate(db, [...byListing.keys()]);
  const confirmed = [];
  for (const row of rows) {
    const entry = byListing.get(row.id);
    for (const kind of [...entry.kinds.keys()].sort((a, b) => rank(a) - rank(b))) {

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
    completeness(right) - completeness(left) ||
    Number(left.created_at || 0) - Number(right.created_at || 0) ||
    String(left.id).localeCompare(String(right.id))
  );
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

export function canonicalUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    if (/^(?:www\.)?wg-gesucht\.de$/iu.test(url.hostname)) {
      const assetId = url.searchParams.get('asset_id') || url.pathname.match(/\.(\d{5,})\.html$/u)?.[1];
      if (assetId && url.searchParams.has('asset_id')) {
        url.search = ''; url.searchParams.set('asset_id', assetId);
        return url.toString().replace(/\/$/, '');
      }
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
    if (/(?:^|\.)wg-gesucht\.de$/u.test(host)) {
      const id = url.searchParams.get('asset_id') || path.match(/\.(\d{5,})\.html$/u)?.[1];
      if (id) return `wgGesucht:${id}`;
    }
    if (/(?:^|\.)kleinanzeigen\.de$/u.test(host)) {
      const id = path.match(/\/(\d+)-\d+-\d+(?:\/|$)/u)?.[1];
      if (id) return `kleinanzeigen:${id}`;
    }
  } catch {
    // Keep malformed historical URLs out of the provider-id kind.
  }
  return null;
}

// Portal IDs survive URL/category changes and historical provider-prefixed aliases.
export function sourceKeyFor(provider, externalId, sourceUrl) {
  const identity = providerListingIdentity(sourceUrl);
  if (identity?.startsWith(`${provider}:`)) return identity.slice(provider.length + 1);
  let declared = String(externalId ?? '').trim();
  if (declared.startsWith(`${provider}:`)) declared = declared.slice(provider.length + 1);
  if (provider === 'kleinanzeigen' && /^\d+-\d+-\d+$/u.test(declared)) declared = declared.split('-')[0];
  return declared && !/^https?:\/\//iu.test(declared) ? declared : canonicalUrl(sourceUrl);
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
              json_extract(a.data, '$.floor') AS floor
       FROM listings l
       LEFT JOIN listing_attributes a ON a.listing_id = l.id
       WHERE l.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(listingIds));
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

function completeness(listing) {
  return ['title', 'price', 'size', 'rooms', 'address', 'link'].filter((key) => listing[key] != null).length;
}
