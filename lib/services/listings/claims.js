/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The single definition of listing identity: claims narrow, vetoes confirm.
 *
 * Resolution has exactly two halves, and neither may be reimplemented anywhere
 * else:
 *
 *   claims narrow — every fact a listing asserts about itself is a row in
 *     `listing_claims`, so finding the rows that could be the same flat is one
 *     indexed `WHERE claim IN (...)` over a primary key. This generalises
 *     `findDetailRepresentative`, which intersected
 *     `listing_sources.dedupe_keys_json` through `json_each` in about fifteen
 *     lines and is the one part of the old dedupe that never produced a
 *     reported bug.
 *
 *   vetoes confirm — claim equality is deliberately lossy, and the checks it
 *     cannot express are precisely the ones that prevent wrong merges.
 *     {@link vetoes} holds them and fails open: nothing to contradict the match
 *     means no veto. A claim is a reason to look, never a decision.
 *
 * This replaces three implementations that disagreed on the same input: five
 * tier functions with four tolerance constants in listings/dedupe.js (live,
 * pre-save), five connect* passes over a union-find in
 * maintenance/canonicalDedupe.js (nightly sweep), and findDetailRepresentative's
 * own second, hand-rolled scan. The nightly sweep is gone with them: a listing
 * now resolves against every claim ever recorded at the moment it is written, so
 * a cross-post that arrives days later is caught in the pipeline rather than
 * merged after the notification has already gone out.
 *
 * Exact facts become claims directly — a canonical URL, a provider expose id, a
 * provider source key, an image content hash. Fuzzy facts are quantised: the
 * value is bucketed and the adjacent bucket is emitted too, so two measurements
 * that straddle a boundary still share a claim. The buckets are deliberately
 * *wider* than the tolerances {@link vetoes} enforces, because the index only
 * has to offer the candidate; the veto decides.
 *
 * Titles are normalised in JS and never in SQL. The old semantic tier compared
 * `lower(trim(l.title))` with `lower(trim(?))`, and SQLite's `lower()` is
 * ASCII-only: "WOHNUNG IN SCHÖNEBERG" and "Wohnung in Schöneberg" differ in the
 * Ö, so the live path never matched that pair while the batch sweep — which
 * lowercased in JS — always did. Two answers to one question, decided by which
 * code path happened to run first. `normalizeText` from lib/shared/values.js is
 * now the only answer.
 *
 * One consequence of `claim` being the primary key: a claim has exactly one
 * owner, so when a veto rejects that owner the claim is spent for everyone —
 * a third listing asserting it resolves to the vetoed owner and never sees the
 * second. That needs a real conflict to fire (two entrances of one development
 * sharing title, rent and floor area) and it is the price of an indexed lookup.
 * The old sweep had the same blind spot in another shape: it evaluated the
 * house-number veto across whole union-find clusters, so one conflicting pair
 * blocked every other edge into that cluster.
 */

import { addressKey } from '../geocoding/address.js';
import { getCachedAccuracy } from '../geocoding/geocodeCache.js';
import { sha256 } from '../../shared/hash.js';
import { tableExists } from '../../shared/sqlite.js';
import { normalizeText, positiveNumber, unique } from '../../shared/values.js';

/**
 * Claim kinds in descending strength. Resolution reports the strongest kind
 * that survived its vetoes, and the caller uses it to tell proof from
 * inference — the distinction the old code drew between "identity evidence" and
 * "resemblance evidence" and which is still load-bearing.
 */
const KIND_PRIORITY = ['cap', 'src', 'pid', 'url', 'sem', 'img', 'geo', 'tps'];

/**
 * Kinds that prove the ad is the same ad rather than inferring it.
 *
 * They match a stored listing whatever state it is in, including hidden and
 * soft-deleted rows, and they are never vetoed. Ignoring hidden rows was how one
 * wg-gesucht ad became four listings and four Telegram messages: every
 * rediscovery was blind to the copies filtering had hidden. Resemblance kinds
 * get the opposite treatment — a guess must never be able to silence a listing
 * by attaching it to something the user cannot see.
 */
const IDENTITY_KINDS = new Set(['cap', 'src', 'pid', 'url']);

/** A district centroid is one point for a whole neighbourhood: no evidence. */
const TRUSTED_ACCURACIES = new Set(['house', 'street']);

/**
 * Buckets are multiplicative for money and for the geo kind's floor area,
 * because the disagreement is proportional: gross versus net area, rent quoted
 * with or without a rounded service charge. 3% per bucket, plus the adjacent
 * bucket, offers everything within 3–6% — comfortably wider than the widest
 * tolerance any veto enforces, which is the invariant that keeps the buckets a
 * recall device and the vetoes the decision.
 */
const RELATIVE_BUCKET_RATIO = 1.03;

/** 0.5 m², plus the neighbour: 0.5–1.0 m² of slack on a stated floor area. */
const SIZE_BUCKET_SQM = 0.5;

/** ~28 m at Berlin's latitude: one building, not one street. */
const COORD_CELL_DEGREES = 2.5e-4;

/**
 * How far two independently reported numbers for one flat may disagree, per
 * kind. These are the decision, not the claim buckets above: the buckets only
 * have to be wide enough to offer the candidate, which is what makes these
 * tunable without regenerating a single claim row.
 */
const PRICE_TOLERANCE = { img: 0.02, geo: 0.05 };
const SIZE_TOLERANCE = { geo: 0.05 };
const SIZE_AGREEMENT = { img: 0.1 };

/** The image tier is only evidence in the plural: one shared photo is not. */
const MIN_SHARED_IMAGES = 2;

/**
 * Every claim a listing asserts.
 *
 * Accepts both shapes the pipeline holds a listing in: the camelCase canonical
 * object built before storage and a `listings` row read back out. Both go
 * through this one function, so a backfilled claim and a runtime claim cannot
 * describe the same fact differently.
 *
 * @param {object} listing canonical listing or stored `listings` row. Optional
 *   extras: `sourceIdentities` ({provider, sourceKey, sourceUrl}[]),
 *   `imageHashes` (string[]), `geocodeAccuracy` (geocode cache accuracy).
 * @returns {{claim: string, kind: string}[]}
 */
export function claimsForListing(listing) {
  if (!listing) return [];
  const claims = [];
  const add = (kind, value) => {
    if (value != null && value !== '') claims.push({ claim: `${kind}:${value}`, kind });
  };

  // This exact capture, already stored. The replay claim exists so that a crash
  // between storing a listing and completing its queue item resolves through the
  // same step as everything else instead of its own bespoke lookup.
  const jobId = listing.jobId ?? listing.job_id ?? null;
  const captureHash = listing.captureHash ?? listing.hash ?? null;
  if (jobId && captureHash) add('cap', `${jobId}|${captureHash}`);

  const identities = (listing.sourceIdentities || []).filter((identity) => identity?.provider && identity?.sourceKey);

  // Only URLs the caller vouches for. `listings.source_urls_json` is
  // deliberately NOT read here: the retired batch sweep wrote every absorbed
  // row's links into its survivor, and one wg-gesucht row in production carries
  // 47 links belonging to unrelated flats. Reading that column as identity made
  // 34 different apartments one cluster. The listing's own link plus the sources
  // the current capture actually collected are the safe anchors — cross-portal
  // identity is the job of the resemblance kinds below.
  const urls = unique([listing.link, ...(listing.sourceUrls || []), ...identities.map((i) => i.sourceUrl)]);
  for (const url of unique(urls.map(canonicalUrl))) add('url', url);
  // The expose id survives query strings canonicalUrl has no rule for, so the
  // same ad reached through two different links still lands on one claim.
  for (const id of unique(urls.map(providerListingIdentity))) add('pid', id);
  for (const identity of identities) add('src', `${identity.provider}:${identity.sourceKey}`);

  for (const hash of unique(listing.imageHashes || [])) add('img', hash);

  const title = titleKey(listing.title);
  const price = positiveNumber(listing.price);
  const size = positiveNumber(listing.size);
  const address = String(listing.address || '').trim();
  const addressTokens = addressTokenKey(address);

  // Titles and address keys enter the claim as a short digest, not verbatim.
  // A claim is an index key and only has to be selective; the exact string
  // comparison lives in vetoes(), where it can be read and changed without
  // regenerating the table. Written out verbatim these two kinds cost 6 MB more
  // on the production database and decided nothing extra.
  if (title && price != null) {
    for (const priceBucket of relativeBuckets(price)) {
      // Identical title, rent and floor area without requiring a comparable
      // address: the same ad cross-posted to two portals routinely fails the
      // address test, because ImmoScout publishes "Türrschmidtstraße 3, 10317
      // Berlin" where Kleinanzeigen publishes only "10317 Lichtenberg". This
      // tier existed only in the nightly sweep, and 88 of 143 historical merges
      // came from exactly that gap — 79 of them between rows created within a
      // week of each other, which the live path had every chance to catch.
      if (size != null) {
        for (const sizeBucket of sizeBuckets(size)) add('tps', `${digest(title)}|${priceBucket}|${sizeBucket}`);
      }
      // Order-insensitive address key: ImmoScout writes "10115 Mitte, Berlin"
      // where Immowelt writes "Mitte, 10115 Berlin", and string equality read
      // those as two flats and notified twice, minutes apart.
      if (addressTokens && /\d/u.test(address)) add('sem', `${digest(`${title}|${addressTokens}`)}|${priceBucket}`);
    }
  }

  // Once the LLM has produced an address and that address is geocoded to a
  // building, the same flat listed twice is two points in one place at one rent
  // with one floor area. Titles get rewritten between portals and galleries get
  // re-encoded, but the building does not move. Rent and area are part of the
  // claim rather than a veto on purpose: coordinates alone are the whole
  // building, so without them the first flat in the block would own the cell and
  // shadow every other flat in it.
  const accuracy = listing.geocodeAccuracy ?? listing.geocode_accuracy ?? null;
  const lat = coordinate(listing.latitude, 90);
  const lng = coordinate(listing.longitude, 180);
  if (price != null && size != null && lat != null && lng != null && TRUSTED_ACCURACIES.has(accuracy)) {
    for (const latCell of cellBuckets(lat)) {
      for (const lngCell of cellBuckets(lng)) {
        for (const priceBucket of relativeBuckets(price)) {
          // Relative, not absolute: the geo veto tolerates 5% on floor area, and
          // half a square metre would have been narrower than the tolerance it
          // is supposed to feed.
          for (const sizeBucket of relativeBuckets(size)) {
            add('geo', `${latCell}|${lngCell}|${priceBucket}|${sizeBucket}`);
          }
        }
      }
    }
  }

  return dedupeClaims(claims);
}

/**
 * Candidate listings that already own any of these claims.
 *
 * One indexed lookup, no scan and no window: a claim recorded years ago is
 * still a claim, which is what lets a late cross-post be caught at write time
 * now that the batch sweep is gone.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {({claim: string}|string)[]} claims
 * @param {{excludeListingId?: string|null}} [options]
 * @returns {{listing_id: string, kind: string, claim: string}[]}
 */
export function resolveClaims(db, claims, { excludeListingId = null } = {}) {
  const keys = claimKeys(claims);
  if (!keys.length || !tableExists(db, 'listing_claims')) return [];
  return db
    .prepare(
      `SELECT claim, listing_id, kind
       FROM listing_claims
       WHERE claim IN (SELECT value FROM json_each(?))
         AND (? IS NULL OR listing_id != ?)`,
    )
    .all(JSON.stringify(keys), excludeListingId, excludeListingId);
}

/**
 * Record the claims a listing asserts. First writer wins, by design: the claim
 * table is also the audit trail of which row an ad was resolved to, and rewriting
 * ownership would erase that.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} listingId
 * @param {({claim: string, kind: string})[]} claims
 * @param {number} [now]
 * @returns {number} claims newly owned by this listing
 */
export function recordClaims(db, listingId, claims, now = Date.now()) {
  if (!listingId || !claims?.length || !tableExists(db, 'listing_claims')) return 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO listing_claims (claim, listing_id, kind, first_seen_at) VALUES (?, ?, ?, ?)`,
  );
  let inserted = 0;
  for (const { claim, kind } of dedupeClaims(claims)) {
    inserted += insert.run(claim, listingId, kind, now).changes;
  }
  return inserted;
}

/**
 * Why these two are NOT the same flat, or null when nothing contradicts it.
 *
 * Fails open on purpose — an absent fact is not a conflict — because every check
 * here compares two portals' independent descriptions of one thing, and the
 * common case is that one of them is silent. The kind of the claim that produced
 * the pair (`right.kind`, as returned by {@link resolveClaims}) selects which
 * checks apply, and identity kinds are never vetoed: they prove sameness, and a
 * proof does not need corroboration.
 *
 * @param {object} left incoming listing (canonical object or row)
 * @param {object} right candidate, carrying `kind` and `geocodeAccuracy`
 * @returns {string|null}
 */
export function vetoes(left, right) {
  if (!left || !right) return 'missing-side';
  const kind = right.kind ?? left.kind ?? null;
  if (kind && IDENTITY_KINDS.has(kind)) return null;

  // "Goeckestraße 34" and "Goeckestraße 34 D" are different doors. A landlord
  // posting one development under consecutive expose ids produces pairs that
  // agree on title, rent and floor area and differ only in the house number.
  if (houseNumberConflict(left.address, right.address)) return 'house-number-conflict';
  // Two flats in one building share coordinates, rent and area; the room count
  // is what separates them. Only a stated disagreement counts.
  if (roomsConflict(left, right)) return 'rooms-conflict';

  if (kind === 'img') {
    // Two shared hashes, never one: a placeholder, a floor plan or an agency
    // logo is shared by everything that agency posts.
    if (sharedImageCount(right) < MIN_SHARED_IMAGES) return 'single-shared-image';
    if (!withinTolerance(left.price, right.price, PRICE_TOLERANCE.img)) return 'price-conflict';
    if (!sizesAgree(left.size, right.size, SIZE_AGREEMENT.img)) return 'size-conflict';
  }
  // The text kinds demand the rent to the cent, because a rent that differs at
  // all is the only thing separating two units the portals describe identically.
  // A serviced-apartment building posts every studio under one title at one
  // address with one floor area — "Neon Wood Student Housing - Deluxe Apartment,
  // Stralsunder Str. 14, 21 m²" at 905 and at 901 euro is two flats, not a price
  // cut, and there is nothing else in the data that says so. Merging wrongly
  // silences a listing; missing a merge only costs a second notification, so the
  // tolerance goes to the kinds that earn it (images, trusted coordinates).
  if (kind === 'sem' || kind === 'tps') {
    // The digest in the claim is a bucket, so the strings are compared here.
    if (titleKey(left.title) !== titleKey(right.title)) return 'title-conflict';
  }
  if (kind === 'sem') {
    if (addressTokenKey(left.address) !== addressTokenKey(right.address)) return 'address-conflict';
    if (!numbersEqual(left.price, right.price)) return 'price-conflict';
    // The two old implementations disagreed here and the batch one was right:
    // the live tier accepted floor areas within half a metre, which merged
    // "Wohnplatz für Studis - Zimmer in 2er-WG, Roedernallee 118F" at 27.68 m²
    // with its neighbour at 27.21 m² — two rooms in one shared flat, both at 380
    // euro. A stated area that differs at all is a different room. Absent on
    // either side it stays fail-open, which is what this kind exists for.
    if (!sizesAgree(left.size, right.size, 0.01)) return 'size-conflict';
  }
  if (kind === 'tps') {
    if (!numbersEqual(left.price, right.price)) return 'price-conflict';
    if (!numbersEqual(left.size, right.size)) return 'size-conflict';
  }
  if (kind === 'geo') {
    if (!withinTolerance(left.price, right.price, PRICE_TOLERANCE.geo)) return 'price-conflict';
    if (!withinTolerance(left.size, right.size, SIZE_TOLERANCE.geo)) return 'size-conflict';
    // Proximity is not identity: a new-build markets near-identical units in
    // adjacent buildings well inside one cell, so the house number has to agree.
    // One side may still carry detail the other omits.
    if (!addressesCompatible(left.address, right.address)) return 'address-conflict';
    // Replaying the geo tier over the stored history, its only wrong merge was a
    // ground-floor flat and a roof-terrace flat sharing nothing but the
    // coordinates of "Prenzlauer Berg, Berlin".
    if (!TRUSTED_ACCURACIES.has(accuracyOf(left)) || !TRUSTED_ACCURACIES.has(accuracyOf(right))) {
      return 'untrusted-geocode';
    }
  }
  return null;
}

/**
 * The whole resolution: claims narrow, vetoes confirm, one comparator elects.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} listing canonical listing or stored row
 * @param {{claims?: {claim: string, kind: string}[], excludeListingId?: string|null}} [options]
 * @returns {{listing: object, kind: string, claim: string, claims: {claim: string, kind: string}[]}|null}
 */
export function resolveListingMatch(db, listing, { claims = null, excludeListingId = null } = {}) {
  const asserted = claims || claimsForListing(listing);
  const matches = resolveClaims(db, asserted, { excludeListingId });
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

  // A guess must never silence a listing the user can see by attaching it to
  // something they cannot. That only bites when the incoming listing would
  // itself have been visible: when it is filtered out too, nothing can be
  // silenced, and merging it onto a hidden row is precisely what the nightly
  // sweep used to do hours later. Identity kinds ignore this entirely — a hidden
  // copy is still a copy, and pretending otherwise turned one wg-gesucht ad into
  // four listings and four Telegram messages.
  const mayMatchHidden = Boolean(listing.hidden_reason || listing.manually_deleted);
  const rows = hydrate(db, [...byListing.keys()]);
  const confirmed = [];
  for (const row of rows) {
    const entry = byListing.get(row.id);
    const hidden = Boolean(row.manually_deleted || row.hidden_reason);
    // Try every kind the pair shares, strongest first: a weak claim of the wrong
    // shape must not hide a strong one, and the reported kind is what the caller
    // uses to decide whether it may revive the row it landed on.
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

/**
 * The one survivor comparator, replacing three that disagreed.
 *
 * Visibility ranks first and schema completeness never outranks it. The
 * inverted order — a "newer shape" beating a visible row — is what let the
 * nightly sweep hide a listing the user could already see and keep the copy
 * nobody had been notified about.
 *
 * @param {object} left `listings` row
 * @param {object} right `listings` row
 * @returns {number}
 */
export function compareSurvivors(left, right) {
  return (
    Number(Boolean(left.manually_deleted || left.hidden_reason)) -
      Number(Boolean(right.manually_deleted || right.hidden_reason)) ||
    Number(right.is_active === 1) - Number(left.is_active === 1) ||
    completeness(right) - completeness(left) ||
    Number(left.created_at || 0) - Number(right.created_at || 0) ||
    String(left.id).localeCompare(String(right.id))
  );
}

/**
 * Claims implied by the source-level dedupe keys the discovery and detail
 * stages store in `listing_sources.dedupe_keys_json`.
 *
 * The two namespaces overlap but are not the same: a source key composes the
 * image hash with a strict evidence fingerprint, because at detail stage there
 * is no listing to veto against. Here the listing exists, so the bare image
 * hash is enough and {@link vetoes} supplies the rest.
 *
 * @param {string[]} keys
 * @returns {{claim: string, kind: string}[]}
 */
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

/**
 * Reduce an address to its significant tokens so the same place written in two
 * portals' house styles compares equal.
 *
 * @param {string} value
 * @returns {string} sorted token key, empty when there is nothing to compare
 */
export function addressTokenKey(value) {
  const tokens = String(value || '')
    .toLocaleLowerCase('de-DE')
    .replace(/ß/gu, 'ss')
    .split(/[^\p{L}\p{N}]+/u)
    // Single letters are noise ("Berlin, D"), but a single digit is a house
    // number and is the whole difference between two flats. Dropping it made
    // "Türrschmidtstraße 3" and "Türrschmidtstraße 9" produce one key, so
    // neighbouring buildings were read as one address.
    .filter((token) => token.length > 1 || /^\d$/u.test(token));
  return [...new Set(tokens)].sort().join(' ');
}

/**
 * Same postal address, allowing one side to carry detail the other omits.
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function addressesCompatible(left, right) {
  // An entrance suffix is part of the house number, not extra verbosity:
  // "Goeckestraße 34" and "Goeckestraße 34 D" are different doors. Token
  // containment alone read them as compatible, because a lone "d" is dropped as
  // noise. Ask the house-number comparison, which keeps the suffix attached.
  if (houseNumberConflict(left, right)) return false;
  const a = new Set(addressTokenKey(left).split(' ').filter(Boolean));
  const b = new Set(addressTokenKey(right).split(' ').filter(Boolean));
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (!large.has(token)) return false;
  return true;
}

/**
 * House numbers named by an address, ignoring the five-digit postcode.
 *
 * @param {string} value
 * @returns {Set<string>}
 */
export function houseNumbers(value) {
  const found = String(value || '').match(/\b\d{1,4}\s?[a-zA-Z]?\b/gu) || [];
  return new Set(found.map((token) => token.replace(/\s+/gu, '').toLowerCase()).filter(Boolean));
}

/**
 * Whether two addresses name different buildings.
 *
 * A development markets identically titled units at one rent and floor area
 * across several entrances — Kirchsteig 111, 117 and 123 all advertise a
 * "3-Zimmer Wohnung freifinanziert" at the same price, so title, rent and area
 * are indistinguishable and only the house number separates the flats. When
 * either address omits a number there is nothing to contradict, so this stays
 * false and the weaker evidence is allowed to stand on its own.
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function houseNumberConflict(left, right) {
  const a = houseNumbers(left);
  const b = houseNumbers(right);
  if (a.size === 0 || b.size === 0) return false;
  for (const token of a) if (b.has(token)) return false;
  return true;
}

/**
 * Deliberately small pre-LLM classifier. Its output is used only for queue
 * dedupe, blacklist routing, and audit. No value produced here may replace an
 * LLM field after the LLM has run.
 *
 * @param {object} listing discovery card
 * @returns {string[]}
 */
export function discoveryDedupeKeys(listing) {
  const link = canonicalUrl(listing?.link);
  return link ? [`url:${link}`] : [];
}

/**
 * @param {{discovery: object, deterministic: object|null, images?: {contentHash?: string}[]}} input
 * @returns {string[]}
 */
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

/**
 * @param {string} value
 * @returns {string}
 */
export function blacklistEvidenceText(value) {
  // Portal branding is chrome, not a statement that the property is a WG.
  return String(value || '').replace(/\bWG-Gesucht(?:\.de)?\b/giu, '');
}

/**
 * @param {string} value
 * @returns {string} canonical form of a listing URL, or the trimmed input
 */
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
    // Listing identity sometimes lives in the query string (notably WG's
    // asset_id). Remove only known tracking parameters.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|ref|referrer|tracking|trackingId)$/iu.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value).trim();
  }
}

/**
 * The provider's own listing id, extracted from a URL. Survives query strings
 * canonicalUrl has no rule for.
 *
 * @param {string} value
 * @returns {string|null}
 */
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

/**
 * Accuracy of the cached geocode for a listing's address, for callers that need
 * to attach it before generating or confirming claims.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} address
 * @returns {string|null}
 */
export function geocodeAccuracyFor(db, address) {
  if (!tableExists(db, 'homeserver_geocode_cache')) return null;
  return getCachedAccuracy(db, addressKey, address);
}

function hydrate(db, listingIds) {
  if (!listingIds.length) return [];
  const rows = db
    .prepare(`SELECT * FROM listings WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(listingIds));
  for (const row of rows) row.geocodeAccuracy = geocodeAccuracyFor(db, row.address);
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

/** A claim component short enough to store, selective enough to index on. */
function digest(value) {
  return sha256(value).slice(0, 16);
}

/** Trailing punctuation is typography, not identity. */
function titleKey(value) {
  return normalizeText(value)
    .replace(/[.,;]+$/u, '')
    .replace(/\|/gu, ' ')
    .trim();
}

/** The bucket a positive value falls in, and its lower neighbour. Both sides
 * emitting both is what lets two values that straddle a boundary still share a
 * claim: {b, b-1} and {b+1, b} intersect at b. */
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
  // -1/-1 is the geocoder's "not found" marker and 0/0 is the null island.
  if (parsed === -1 || Math.abs(parsed) > limit) return null;
  return parsed === 0 ? null : parsed;
}

function accuracyOf(side) {
  return side?.geocodeAccuracy ?? side?.geocode_accuracy ?? null;
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

/** Fail open: sizes agree when either is absent, or both are within `slack`. */
function sizesAgree(left, right, slack) {
  const a = positiveNumber(left);
  const b = positiveNumber(right);
  if (a == null || b == null) return true;
  return Math.abs(a - b) <= slack;
}

function numbersEqual(left, right) {
  const a = positiveNumber(left);
  const b = positiveNumber(right);
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 0.01;
}

function withinTolerance(left, right, tolerance) {
  const a = positiveNumber(left);
  const b = positiveNumber(right);
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= tolerance * Math.max(a, b);
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
