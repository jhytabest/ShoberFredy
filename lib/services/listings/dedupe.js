/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Unified duplicate detection, run BEFORE save: a duplicate is never stored.
 *
 * The layers are ordered by how much the pipeline knows at the point they can
 * run, and each stage may use every layer available to the stages before it:
 *
 *   discovery — provider source key, canonical URL. Identity only, but exact.
 *   detail    — adds the gallery image hashes and the card's own title/price.
 *   final     — adds the LLM's canonical address and the geocoded coordinates,
 *               so a flat can be recognised from where it is and what it costs
 *               even when two portals share no text and no images.
 *
 * Two kinds of evidence, deliberately treated differently:
 *
 *   Identity evidence (source key, canonical URL) proves the ad is the same ad.
 *   It matches a stored listing whatever state that listing is in, including
 *   hidden and soft-deleted ones. Ignoring those was how one wg-gesucht ad
 *   became four listing rows and four Telegram messages: each rediscovery could
 *   not see the copies already stored, because filtering had hidden them.
 *
 *   Resemblance evidence (title, images, coordinates plus price and size) is a
 *   strong inference, not a proof, so it only ever matches a visible listing.
 *   A guess must never be able to silence a listing by attaching it to
 *   something the user cannot see.
 *
 * Cross-job matching is scoped to one owner so one user's discovery can never
 * suppress another user's notification. Fails open: any error keeps the listing.
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { addressKey } from '../geocoding/address.js';
import { canonicalUrl } from '../pipeline/temporaryDeterministic.js';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PRICE_TOLERANCE = 0.02;
const COORD_EPSILON = 1e-5; // ~1.1 m at Berlin's latitude
const TRUSTED_ACCURACIES = new Set(['house', 'street']);

/**
 * The final layer compares two independently reported numbers for the same
 * flat, so it has to tolerate the portals disagreeing slightly: gross vs. net
 * floor area, rent quoted with or without a rounded service charge. Five per
 * cent absorbs that without reaching the next flat in the building, which
 * differs by far more.
 */
const FINAL_PRICE_TOLERANCE = 0.05;
const FINAL_SIZE_TOLERANCE = 0.05;

/** ~28 m at Berlin's latitude: one building, not one street. */
const FINAL_COORD_EPSILON = 2.5e-4;

/** Which layers may run once the pipeline has reached a given stage. */
const STAGE_LAYERS = {
  discovery: ['exactSource'],
  detail: ['exactSource', 'semantic', 'image'],
  final: ['exactSource', 'semantic', 'image', 'geoPriceSize', 'storedCoordinates'],
};

function geocodeAccuracy(db, address) {
  if (!address) return null;
  const row = db
    .prepare(`SELECT accuracy FROM homeserver_geocode_cache WHERE address_key = ? AND status = 'ok'`)
    .get(addressKey(address));
  return row ? row.accuracy : null;
}

function priceClose(a, b) {
  return Math.abs(a - b) <= PRICE_TOLERANCE * Math.max(a, b);
}

/**
 * Strongest identity layer: the same provider source key or canonical source
 * URL is always the same ad, even after a price change or historical backfill.
 * Scope across all jobs owned by the same user, never across users.
 */
function findExactSourceDuplicate(db, listing) {
  if (!tableExists(db, 'jobs') || !tableExists(db, 'listing_sources')) return null;
  const identities = (listing.sourceIdentities || [])
    .filter((identity) => identity?.provider && identity?.sourceKey)
    .map((identity) => ({ provider: identity.provider, sourceKey: identity.sourceKey }));
  const urls = unique([
    listing.link,
    ...(listing.sourceUrls || []),
    ...(listing.sourceIdentities || []).map((identity) => identity?.sourceUrl),
  ]).flatMap((url) => unique([url, canonicalUrl(url)]));
  if (!identities.length && !urls.length) return null;

  // Deliberately not filtered on visibility: this layer proves sameness, and a
  // hidden copy is still a copy. Visible rows are preferred so the caller
  // merges into the row the user can actually see when one exists.
  return (
    db
      .prepare(
        `SELECT DISTINCT l.id, l.job_id, l.provider, l.link, l.price, l.address,
                l.hidden_reason, l.manually_deleted
         FROM listings l
         JOIN jobs owner ON owner.id = l.job_id
         LEFT JOIN jobs incoming ON incoming.id = @jobId
         LEFT JOIN listing_sources source ON source.listing_id = l.id
         WHERE (@jobId IS NULL OR owner.user_id = incoming.user_id)
           AND (
             l.link IN (SELECT value FROM json_each(@urls))
             OR EXISTS (
               SELECT 1 FROM json_each(COALESCE(l.source_urls_json, '[]')) known
               WHERE known.value IN (SELECT value FROM json_each(@urls))
             )
             OR EXISTS (
               SELECT 1 FROM json_each(@identities) identity
               WHERE source.provider = json_extract(identity.value, '$.provider')
                 AND source.source_key = json_extract(identity.value, '$.sourceKey')
             )
           )
         ORDER BY
           CASE WHEN l.manually_deleted = 0 AND l.hidden_reason IS NULL THEN 0 ELSE 1 END,
           l.is_active DESC,
           l.created_at ASC
         LIMIT 1`,
      )
      .get({
        jobId: listing.jobId ?? null,
        urls: JSON.stringify(urls),
        identities: JSON.stringify(identities),
      }) || null
  );
}

/**
 * Geospatial layer: a stored, visible, recent listing covers the same flat
 * when both geocodes are trustworthy and size/price agree.
 * The incoming listing is not yet saved, so no self-match is possible.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} listing
 * @returns {object|null} the covering row, or null
 */
function findStoredDuplicate(db, listing) {
  const price = Number(listing.price);
  const size = Number(listing.size);
  // Without a comparable size and price the match would be coordinates-only,
  // which merges distinct flats in the same building/street — skip instead.
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) return null;

  const lat = Number(listing.latitude);
  const lng = Number(listing.longitude);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && lat !== -1 && lng !== -1;
  const coordsTrusted = hasCoords && TRUSTED_ACCURACIES.has(geocodeAccuracy(db, listing.address));
  const hasJobs = tableExists(db, 'jobs');
  const jobsJoin = hasJobs
    ? 'JOIN jobs owner ON owner.id = l.job_id LEFT JOIN jobs incoming ON incoming.id = @jobId'
    : '';
  const ownerScope = hasJobs
    ? '(@jobId IS NULL OR owner.user_id = incoming.user_id)'
    : '(@jobId IS NULL OR l.job_id = @jobId)';
  const hiddenScope = columnExists(db, 'listings', 'hidden_reason') ? 'AND l.hidden_reason IS NULL' : '';
  const sourceLinkMatch = columnExists(db, 'listings', 'source_urls_json')
    ? `l.link = @link OR EXISTS (
         SELECT 1 FROM json_each(COALESCE(l.source_urls_json, '[]')) source
         WHERE source.value = @link
       )`
    : 'l.link = @link';

  const candidates = db
    .prepare(
      `
      SELECT l.id, l.job_id, l.provider, l.link, l.price, l.address
      FROM listings l
      ${jobsJoin}
      WHERE l.manually_deleted = 0
        ${hiddenScope}
        AND ${ownerScope}
        AND l.created_at >= @cutoff
        AND l.size = @size
        AND (
          (@link != '' AND (${sourceLinkMatch}))
          OR (
            @coordsTrusted = 1
            AND ABS(l.latitude - @lat) < @eps
            AND ABS(l.longitude - @lng) < @eps
          )
        )
      `,
    )
    .all({
      cutoff: Date.now() - WINDOW_MS,
      jobId: listing.jobId ?? null,
      size,
      link: listing.link ?? '',
      coordsTrusted: coordsTrusted ? 1 : 0,
      lat: hasCoords ? lat : null,
      lng: hasCoords ? lng : null,
      eps: COORD_EPSILON,
    });

  for (const candidate of candidates) {
    const candidatePrice = Number(candidate.price);
    if (!Number.isFinite(candidatePrice) || candidatePrice <= 0 || !priceClose(price, candidatePrice)) continue;
    if (candidate.link && listing.link && candidate.link === listing.link) return candidate;
    if (TRUSTED_ACCURACIES.has(geocodeAccuracy(db, candidate.address))) return candidate;
  }
  return null;
}

/**
 * Reduce an address to its set of significant tokens, so the same place written
 * in two portals' house styles compares equal. ImmoScout writes
 * "10115 Mitte, Berlin" where Immowelt writes "Mitte, 10115 Berlin" — string
 * equality treated those as different flats and let the same ad through twice,
 * once per portal, with two notifications minutes apart.
 *
 * @param {string} value
 * @returns {string} sorted token key, empty when there is nothing to compare
 */
export function addressTokenKey(value) {
  const tokens = String(value || '')
    .toLocaleLowerCase('de-DE')
    .replace(/ß/gu, 'ss')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
  return [...new Set(tokens)].sort().join(' ');
}

/**
 * Same postal address, allowing one side to carry extra detail the other omits.
 * Keeps the house number significant inside the geo layer's radius.
 */
export function addressesCompatible(left, right) {
  const a = new Set(addressTokenKey(left).split(' ').filter(Boolean));
  const b = new Set(addressTokenKey(right).split(' ').filter(Boolean));
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (!large.has(token)) return false;
  return true;
}

/** Sizes agree when both are absent, or both present and equal to the cm². */
function sizeAgrees(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || left <= 0 || !Number.isFinite(right) || right <= 0) return true;
  return Math.abs(left - right) < 0.5;
}

function findSemanticDuplicate(db, listing) {
  const title = String(listing.title || '').trim();
  const address = String(listing.address || '').trim();
  const price = Number(listing.price);
  if (!title || !address || !Number.isFinite(price) || price <= 0) return null;
  const addressKeyed = addressTokenKey(address);
  if (!addressKeyed) return null;
  const hasJobs = tableExists(db, 'jobs');
  const jobsJoin = hasJobs ? 'JOIN jobs owner ON owner.id = l.job_id LEFT JOIN jobs incoming ON incoming.id = ?' : '';
  const ownerScope = hasJobs ? '(? IS NULL OR owner.user_id = incoming.user_id)' : '(? IS NULL OR l.job_id = ?)';
  const hiddenScope = columnExists(db, 'listings', 'hidden_reason') ? 'AND l.hidden_reason IS NULL' : '';
  const jobId = listing.jobId ?? null;
  // Title and price stay in SQL because they are exact; the address comparison
  // is order-insensitive and so has to happen in JS over the few candidates.
  const candidates = db
    .prepare(
      `SELECT l.id, l.job_id, l.provider, l.link, l.price, l.address, l.size
       FROM listings l
       ${jobsJoin}
       WHERE l.manually_deleted = 0
         ${hiddenScope}
         AND ${ownerScope}
         AND l.created_at >= ?
         AND lower(trim(l.title)) = lower(trim(?))
         AND l.price = ?
       ORDER BY l.created_at ASC`,
    )
    .all(jobId, jobId, Date.now() - WINDOW_MS, title, price);

  return (
    candidates.find(
      (candidate) => addressTokenKey(candidate.address) === addressKeyed && sizeAgrees(candidate.size, listing.size),
    ) || null
  );
}

/**
 * Media layer: two shared optimized image hashes plus matching size and price
 * are a strong cross-portal identity without trusting titles or addresses.
 */
function findImageDuplicate(db, listing) {
  if (!tableExists(db, 'jobs') || !tableExists(db, 'listing_images')) return null;
  const hashes = unique(listing.imageHashes || []);
  const price = Number(listing.price);
  const size = Number(listing.size);
  if (hashes.length < 2 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  const candidates = db
    .prepare(
      `SELECT l.id, l.job_id, l.provider, l.link, l.price, l.address,
              COUNT(DISTINCT image.content_hash) AS shared_images
       FROM listings l
       JOIN jobs owner ON owner.id = l.job_id
       LEFT JOIN jobs incoming ON incoming.id = @jobId
       JOIN listing_images image ON image.listing_id = l.id
       WHERE l.manually_deleted = 0
         AND l.hidden_reason IS NULL
         AND (@jobId IS NULL OR owner.user_id = incoming.user_id)
         AND l.created_at >= @cutoff
         AND l.size = @size
         AND image.content_hash IN (SELECT value FROM json_each(@hashes))
       GROUP BY l.id
       HAVING COUNT(DISTINCT image.content_hash) >= 2
       ORDER BY shared_images DESC, l.created_at ASC`,
    )
    .all({
      jobId: listing.jobId ?? null,
      cutoff: Date.now() - WINDOW_MS,
      size,
      hashes: JSON.stringify(hashes),
    });
  return (
    candidates.find((candidate) => {
      const candidatePrice = Number(candidate.price);
      return Number.isFinite(candidatePrice) && candidatePrice > 0 && priceClose(price, candidatePrice);
    }) || null
  );
}

/**
 * Final layer, and the only one that needs nothing the portals share.
 *
 * Once the LLM has produced a canonical address and that address has been
 * geocoded, the same flat listed twice is two points at the same place with the
 * same rent and the same floor area. Titles get rewritten between portals,
 * galleries get re-encoded so the image hashes differ, addresses get reordered
 * — but the building does not move and the rent does not change.
 *
 * The conditions are required together on purpose. Coordinates alone merge
 * every flat in one building; rent and size together are what make the point
 * identify a specific flat rather than an address. Room counts are used only to
 * veto: when both sides state one and they disagree, it is not the same flat.
 *
 * Both geocodes must also be house- or street-accurate. A district centroid is
 * the same point for an entire neighbourhood, so it carries no evidence about
 * the building — replaying this layer over the stored history, the only wrong
 * merge it produced was a ground-floor flat and a roof-terrace flat that shared
 * nothing but the coordinates of "Prenzlauer Berg, Berlin".
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} listing
 * @returns {object|null}
 */
function findGeoPriceSizeDuplicate(db, listing) {
  const price = Number(listing.price);
  const size = Number(listing.size);
  const lat = Number(listing.latitude);
  const lng = Number(listing.longitude);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(size) || size <= 0) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === -1 || lng === -1) return null;
  if (!TRUSTED_ACCURACIES.has(geocodeAccuracy(db, listing.address))) return null;

  const rooms = Number(listing.rooms);
  const hasJobs = tableExists(db, 'jobs');
  const jobsJoin = hasJobs
    ? 'JOIN jobs owner ON owner.id = l.job_id LEFT JOIN jobs incoming ON incoming.id = @jobId'
    : '';
  const ownerScope = hasJobs
    ? '(@jobId IS NULL OR owner.user_id = incoming.user_id)'
    : '(@jobId IS NULL OR l.job_id = @jobId)';

  // Resemblance evidence: visible rows only.
  const candidates = db
    .prepare(
      `SELECT l.id, l.job_id, l.provider, l.link, l.price, l.size, l.rooms, l.address,
              l.latitude, l.longitude, l.hidden_reason, l.manually_deleted
       FROM listings l
       ${jobsJoin}
       WHERE l.manually_deleted = 0
         AND l.hidden_reason IS NULL
         AND ${ownerScope}
         AND l.created_at >= @cutoff
         AND l.latitude IS NOT NULL
         AND l.longitude IS NOT NULL
         AND ABS(l.latitude - @lat) < @eps
         AND ABS(l.longitude - @lng) < @eps
       ORDER BY l.created_at ASC`,
    )
    .all({
      jobId: listing.jobId ?? null,
      cutoff: Date.now() - WINDOW_MS,
      lat,
      lng,
      eps: FINAL_COORD_EPSILON,
    });

  return (
    candidates.find((candidate) => {
      if (!withinTolerance(price, candidate.price, FINAL_PRICE_TOLERANCE)) return false;
      if (!withinTolerance(size, candidate.size, FINAL_SIZE_TOLERANCE)) return false;
      const candidateRooms = Number(candidate.rooms);
      if (Number.isFinite(rooms) && rooms > 0 && Number.isFinite(candidateRooms) && candidateRooms > 0) {
        if (Math.abs(rooms - candidateRooms) > 0.01) return false;
      }
      // Proximity is not identity: a new-build markets near-identical units in
      // adjacent buildings well inside this radius, so the house number has to
      // agree. One address may still carry detail the other omits.
      if (!addressesCompatible(listing.address, candidate.address)) return false;
      return TRUSTED_ACCURACIES.has(geocodeAccuracy(db, candidate.address));
    }) || null
  );
}

/** Relative agreement between two positive numbers. */
function withinTolerance(a, b, tolerance) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || left <= 0 || !Number.isFinite(right) || right <= 0) return false;
  return Math.abs(left - right) <= tolerance * Math.max(left, right);
}

/**
 * Return the stored representative instead of throwing away its new source.
 *
 * @param {object} listing candidate, not yet stored
 * @param {{stage?: 'discovery'|'detail'|'final'}} [options] how far the listing
 * has progressed; determines which evidence is trusted to exist. Defaults to
 * `final`, the richest.
 * @returns {object|null} the covering row, carrying its `hidden_reason` and
 * `manually_deleted` so the caller can tell a merge from a suppression.
 */
export function findDuplicate(listing, { stage = 'final' } = {}) {
  let db;
  try {
    db = SqliteConnection.getConnection();
  } catch {
    return null;
  }
  const layers = STAGE_LAYERS[stage] || STAGE_LAYERS.final;
  const runnable = {
    exactSource: () => findExactSourceDuplicate(db, listing),
    semantic: () => (hasSemanticIdentity(listing) ? findSemanticDuplicate(db, listing) : null),
    image: () => findImageDuplicate(db, listing),
    geoPriceSize: () => findGeoPriceSizeDuplicate(db, listing),
    storedCoordinates: () => findStoredDuplicate(db, listing),
  };
  for (const layer of layers) {
    const match = runnable[layer]?.();
    if (match) return { ...match, matchedBy: layer };
  }
  return null;
}

function hasSemanticIdentity(listing) {
  const price = Number(listing.price);
  return (
    typeof listing.title === 'string' &&
    listing.title.trim() !== '' &&
    typeof listing.address === 'string' &&
    listing.address.trim() !== '' &&
    Number.isFinite(price) &&
    price > 0
  );
}

function tableExists(db, table) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
}

function columnExists(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((entry) => entry.name === column);
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}
