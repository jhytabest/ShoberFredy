/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Owner-scoped canonical database maintenance.
 *
 * Includes visible and filtered production listings. Exact sources, provider IDs,
 * semantic identity, shared images, and trusted coordinates+size+price are
 * accepted duplicate evidence.
 */

import { canonicalUrl } from '../pipeline/temporaryDeterministic.js';
import { addressKey } from '../geocoding/address.js';
import { addressTokenKey, addressesCompatible, houseNumberConflict } from '../listings/dedupe.js';
import SqliteConnection from '../storage/SqliteConnection.js';

const PRICE_TOLERANCE = 0.02;
// The geo tier compares two portals' independent measurements of one flat, so
// it carries the same tolerances as the live final dedupe layer: gross vs. net
// floor area and rent quoted with or without a rounded service charge both move
// the numbers by a few per cent. Kept in step with lib/services/listings/dedupe.js.
const GEO_PRICE_TOLERANCE = 0.05;
const GEO_SIZE_TOLERANCE = 0.05;
const GEO_COORD_EPSILON = 2.5e-4; // ~28 m at Berlin's latitude: one building
const TRUSTED_ACCURACIES = new Set(['house', 'street']);
const TIER_ORDER = ['exact_source', 'provider_id', 'semantic', 'images', 'trusted_geo', 'title_price_size'];

export function findCanonicalDuplicateClusters(db = SqliteConnection.getConnection()) {
  db.pragma('temp_store = MEMORY');
  const listings = db
    .prepare(
      // Rows already absorbed by a previous pass are excluded: they are kept
      // as the record that their ad was resolved, and reconsidering them would
      // re-run the merge on every scheduled dedupe.
      `SELECT listing.*, job.user_id
       FROM listings listing
       JOIN jobs job ON job.id = listing.job_id
       WHERE listing.hidden_reason IS NULL OR listing.hidden_reason <> 'duplicate'
       ORDER BY listing.created_at, listing.id`,
    )
    .all();
  const byId = new Map(listings.map((listing) => [listing.id, listing]));
  const union = new UnionFind(listings.map(({ id }) => id));
  const edges = [];
  const connect = (left, right, tier, evidence) => {
    if (!left || !right || left === right) return;
    const a = byId.get(left);
    const b = byId.get(right);
    if (!a || !b || a.user_id !== b.user_id) return;
    if (!['exact_source', 'provider_id'].includes(tier)) {
      const leftMembers = union.members(left).map((id) => byId.get(id));
      const rightMembers = union.members(right).map((id) => byId.get(id));
      if (leftMembers.some((x) => rightMembers.some((y) => houseNumberConflict(x?.address, y?.address)))) return;
    }
    union.join(left, right);
    edges.push({ left, right, tier, evidence });
  };

  connectIdentityMaps(listings, connect);
  connectSemantic(listings, connect);
  connectImages(db, listings, connect);
  connectTrustedGeo(db, listings, connect);
  connectTitlePriceSize(listings, connect);

  const grouped = new Map();
  for (const listing of listings) {
    const root = union.root(listing.id);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(listing);
  }
  return [...grouped.values()]
    .filter((members) => members.length > 1)
    .map((members) => {
      const ids = new Set(members.map(({ id }) => id));
      const clusterEdges = edges
        .filter(({ left, right }) => ids.has(left) && ids.has(right))
        .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
      const representative = [...members].sort(compareRepresentative)[0];
      return {
        representative,
        duplicates: members.filter(({ id }) => id !== representative.id),
        members,
        edges: clusterEdges,
        strongestTier: clusterEdges[0]?.tier || 'unknown',
      };
    })
    .sort((a, b) => a.representative.created_at - b.representative.created_at);
}

export function applyCanonicalDedupe(db = SqliteConnection.getConnection()) {
  const clusters = findCanonicalDuplicateClusters(db);
  const summary = summarize(clusters);
  for (const cluster of clusters) {
    for (const duplicate of cluster.duplicates) {
      const evidence = cluster.edges.filter(
        ({ left, right }) =>
          left === duplicate.id ||
          right === duplicate.id ||
          left === cluster.representative.id ||
          right === cluster.representative.id,
      );
      absorbDuplicate(db, cluster.representative.id, duplicate.id, cluster.strongestTier, evidence);
    }
  }
  return summary;
}

function connectIdentityMaps(listings, connect) {
  const exact = new Map();
  const providerIds = new Map();
  for (const listing of listings) {
    // Historical source rows and source_urls_json can already contain links
    // absorbed from several unrelated listings. Only the listing's own primary
    // URL is a safe identity anchor; cross-portal identity is handled by the
    // independent semantic/image/trusted-coordinate tiers below.
    const canonical = canonicalUrl(listing.link);
    if (canonical) {
      connectMap(exact, `${listing.user_id}|url:${canonical}`, listing.id, connect, { url: canonical });
    }
    const providerId = providerListingIdentity(listing.link);
    if (providerId) {
      connectMap(providerIds, `${listing.user_id}|${providerId}`, listing.id, connect, { providerId }, 'provider_id');
    }
  }
}

function connectSemantic(listings, connect) {
  const identities = new Map();
  for (const listing of listings) {
    const title = normalize(listing.title);
    const address = normalize(listing.address);
    const price = finitePositive(listing.price);
    const size = finitePositive(listing.size);
    if (!title || !address || !/\d/u.test(address) || price == null || size == null) continue;
    // Order-insensitive address key: ImmoScout writes "10115 Mitte, Berlin"
    // where Immowelt writes "Mitte, 10115 Berlin", and exact string equality
    // read those as two different flats.
    const key = `${listing.user_id}|${title}|${addressTokenKey(address)}|${price}|${size}`;
    connectMap(identities, key, listing.id, connect, { title, address, price, size }, 'semantic');
  }
}

/**
 * Identical title, rent to the cent and floor area to the square centimetre.
 *
 * The semantic tier above also demands a matching address carrying a house
 * number, which the same ad cross-posted to two portals frequently fails: one
 * writes "Türrschmidtstraße 3, 10317 Berlin" and the other only
 * "10317 Lichtenberg". Three exactly equal values are already strong evidence
 * on their own, so this tier drops the address requirement and instead refuses
 * to merge when the addresses name different buildings.
 */
function connectTitlePriceSize(listings, connect) {
  const groups = new Map();
  for (const listing of listings) {
    const title = normalize(listing.title);
    const price = finitePositive(listing.price);
    const size = finitePositive(listing.size);
    if (!title || price == null || size == null) continue;
    const key = `${listing.user_id}|${title}|${price}|${size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(listing);
  }
  for (const group of groups.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const a = group[left];
        const b = group[right];
        if (houseNumberConflict(a.address, b.address)) continue;
        connect(a.id, b.id, 'title_price_size', { title: normalize(a.title), price: a.price, size: a.size });
      }
    }
  }
}

function connectImages(db, listings, connect) {
  const listingById = new Map(listings.map((listing) => [listing.id, listing]));
  const hashes = db
    .prepare(
      `SELECT listing_id, content_hash
       FROM listing_images
       WHERE listing_id IS NOT NULL
         AND download_status = 'stored'
         AND content_hash IS NOT NULL
       GROUP BY listing_id, content_hash`,
    )
    .all();
  const byHash = groupBy(hashes, ({ content_hash }) => content_hash);
  const shared = new Map();
  for (const rows of byHash.values()) {
    for (let left = 0; left < rows.length; left += 1) {
      for (let right = left + 1; right < rows.length; right += 1) {
        const a = listingById.get(rows[left].listing_id);
        const b = listingById.get(rows[right].listing_id);
        if (!a || !b || a.user_id !== b.user_id) continue;
        const key = pairKey(a.id, b.id);
        shared.set(key, (shared.get(key) || 0) + 1);
      }
    }
  }
  for (const [key, count] of shared) {
    if (count < 2) continue;
    const [leftId, rightId] = key.split('|');
    const left = listingById.get(leftId);
    const right = listingById.get(rightId);
    if (!sameSize(left, right) || !priceClose(left.price, right.price)) continue;
    connect(left.id, right.id, 'images', { sharedImages: count, size: left.size });
  }
}

function connectTrustedGeo(db, listings, connect) {
  const accuracy = new Map(
    db
      .prepare(
        `SELECT address_key, accuracy FROM homeserver_geocode_cache
         WHERE status = 'ok' AND accuracy IN ('house', 'street')`,
      )
      .all()
      .map((row) => [row.address_key, row.accuracy]),
  );
  const buckets = new Map();
  for (const listing of listings) {
    const size = finitePositive(listing.size);
    if (listing.latitude == null || listing.longitude == null) continue;
    const latitude = Number(listing.latitude);
    const longitude = Number(listing.longitude);
    const precision = accuracy.get(addressKey(listing.address));
    if (
      size == null ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180 ||
      (latitude === 0 && longitude === 0) ||
      !TRUSTED_ACCURACIES.has(precision)
    ) {
      continue;
    }
    const latCell = Math.floor(latitude / GEO_COORD_EPSILON);
    const lngCell = Math.floor(longitude / GEO_COORD_EPSILON);
    const candidate = { listing, latitude, longitude, precision };
    for (let latOffset = -1; latOffset <= 1; latOffset += 1) {
      for (let lngOffset = -1; lngOffset <= 1; lngOffset += 1) {
        const neighbors = buckets.get(`${listing.user_id}|${latCell + latOffset}|${lngCell + lngOffset}`) || [];
        for (const other of neighbors) {
          const a = candidate;
          const b = other;
          if (
            Math.abs(a.latitude - b.latitude) >= GEO_COORD_EPSILON ||
            Math.abs(a.longitude - b.longitude) >= GEO_COORD_EPSILON ||
            !withinTolerance(a.listing.price, b.listing.price, GEO_PRICE_TOLERANCE) ||
            !withinTolerance(a.listing.size, b.listing.size, GEO_SIZE_TOLERANCE) ||
            roomsConflict(a.listing, b.listing) ||
            !addressesCompatible(a.listing.address, b.listing.address)
          ) {
            continue;
          }
          connect(a.listing.id, b.listing.id, 'trusted_geo', {
            latitude: a.latitude,
            longitude: a.longitude,
            size: a.listing.size,
            prices: [a.listing.price, b.listing.price],
            precisions: [a.precision, b.precision],
          });
        }
      }
    }
    const key = `${listing.user_id}|${latCell}|${lngCell}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(candidate);
  }
}

function absorbDuplicate(db, representativeId, duplicateId, tier, evidence) {
  db.transaction(() => {
    const representative = db.prepare('SELECT * FROM listings WHERE id = ?').get(representativeId);
    const duplicate = db.prepare('SELECT * FROM listings WHERE id = ?').get(duplicateId);
    if (!representative || !duplicate) return;
    const duplicateSourceUrls = db
      .prepare('SELECT source_url FROM listing_sources WHERE listing_id = ?')
      .all(duplicateId)
      .map(({ source_url }) => source_url);
    const urls = unique([
      representative.link,
      duplicate.link,
      ...parseArray(representative.source_urls_json),
      ...parseArray(duplicate.source_urls_json),
      ...duplicateSourceUrls,
    ]);
    db.prepare(
      `UPDATE listings
       SET source_urls_json = ?,
           created_at = COALESCE(MIN(created_at, ?), created_at, ?),
           is_active = COALESCE(MAX(is_active, ?), is_active, ?, 0),
           inactive_at = CASE WHEN COALESCE(MAX(is_active, ?), is_active, ?, 0) = 1 THEN NULL ELSE inactive_at END,
           inactive_reason = CASE WHEN COALESCE(MAX(is_active, ?), is_active, ?, 0) = 1 THEN NULL ELSE inactive_reason END
       WHERE id = ?`,
    ).run(
      JSON.stringify(urls),
      duplicate.created_at,
      duplicate.created_at,
      duplicate.is_active,
      duplicate.is_active,
      duplicate.is_active,
      duplicate.is_active,
      duplicate.is_active,
      duplicate.is_active,
      representativeId,
    );

    db.prepare(
      `UPDATE listing_sources
       SET listing_id = ?, dedupe_stage = 'historical_final'
       WHERE listing_id = ?`,
    ).run(representativeId, duplicateId);
    db.prepare('UPDATE parsing_queue SET listing_id = ? WHERE listing_id = ?').run(representativeId, duplicateId);
    db.prepare('UPDATE listing_extractions SET listing_id = ? WHERE listing_id = ?').run(representativeId, duplicateId);
    db.prepare('UPDATE listing_images SET listing_id = ? WHERE listing_id = ?').run(representativeId, duplicateId);
    db.prepare('UPDATE llm_call_audit SET listing_id = ? WHERE listing_id = ?').run(representativeId, duplicateId);
    db.prepare('UPDATE pipeline_audit_events SET listing_id = ? WHERE listing_id = ?').run(
      representativeId,
      duplicateId,
    );
    mergeStructuredData(db, representativeId, duplicateId);
    mergeNotifications(db, representativeId, duplicateId);
    mergeRating(db, representativeId, duplicateId, representative);

    // The absorbed row is hidden, never removed — the same treatment a
    // blacklisted listing gets. It is the record that this provider offer has
    // already been seen and resolved, and that record is what stops the ad
    // being fetched and notified again the next time discovery turns it up.
    // Its own source_urls_json still names every URL it stood for.
    db.prepare(
      `UPDATE listings
       SET hidden_reason = 'duplicate',
           manually_deleted = 1,
           filter_reasons_json = json_insert(
             COALESCE(NULLIF(filter_reasons_json, ''), '[]'), '$[#]',
             json_object('code', 'duplicate', 'stage', 'historical_final',
                         'representative', ?, 'tier', ?)
           )
       WHERE id = ?`,
    ).run(representativeId, tier, duplicateId);
    db.prepare(
      `INSERT INTO pipeline_audit_events (
         source_id, listing_id, queue_id, stage, action, reason, payload_json, created_at
       ) VALUES (NULL, ?, NULL, 'historical_final_dedupe', 'merged', ?, ?, ?)`,
    ).run(
      representativeId,
      `Absorbed listing ${duplicateId}`,
      JSON.stringify({ duplicateId, tier, evidence }),
      Date.now(),
    );
  })();
}

function mergeStructuredData(db, representativeId, duplicateId) {
  db.prepare(
    `INSERT INTO listing_texts(listing_id, full_text, content_hash, captured_at)
     SELECT ?, full_text, content_hash, captured_at
     FROM listing_texts WHERE listing_id = ?
     ON CONFLICT(listing_id) DO UPDATE SET
       full_text = CASE
         WHEN length(excluded.full_text) > length(full_text) THEN excluded.full_text
         ELSE full_text
       END,
       content_hash = CASE
         WHEN length(excluded.full_text) > length(full_text) THEN excluded.content_hash
         ELSE content_hash
       END,
       captured_at = CASE
         WHEN length(excluded.full_text) > length(full_text) THEN excluded.captured_at
         ELSE captured_at
       END`,
  ).run(representativeId, duplicateId);

  const hasAttributes = db.prepare('SELECT 1 FROM listing_attributes WHERE listing_id = ?').get(representativeId);
  if (!hasAttributes) {
    db.prepare('UPDATE listing_attributes SET listing_id = ? WHERE listing_id = ?').run(representativeId, duplicateId);
  }

  db.prepare(
    `INSERT OR IGNORE INTO homeserver_listing_model_scores (
       listing_id, model_family, model_version, scored_at, model_created_at,
       actual_price_per_sqm, fair_price_per_sqm, fair_lo_price_per_sqm, fair_hi_price_per_sqm,
       coverage_level, delta_percent, comps_500m, coord_quality, price_type, swap
     )
     SELECT ?, model_family, model_version, scored_at, model_created_at,
            actual_price_per_sqm, fair_price_per_sqm, fair_lo_price_per_sqm, fair_hi_price_per_sqm,
            coverage_level, delta_percent, comps_500m, coord_quality, price_type, swap
     FROM homeserver_listing_model_scores WHERE listing_id = ?`,
  ).run(representativeId, duplicateId);
}

function mergeNotifications(db, representativeId, duplicateId) {
  const rows = db.prepare('SELECT * FROM notification_deliveries WHERE listing_id = ?').all(duplicateId);
  for (const row of rows) {
    const conflict = db
      .prepare(
        `SELECT id FROM notification_deliveries
         WHERE listing_id = ? AND adapter_id = ? AND adapter_ordinal = ?`,
      )
      .get(representativeId, row.adapter_id, row.adapter_ordinal);
    // Move the delivery to the representative unless it already has one for
    // that adapter; on collision it stays on the absorbed row, which is
    // retained. Either way the send remains recorded exactly once.
    if (!conflict) {
      db.prepare('UPDATE notification_deliveries SET listing_id = ? WHERE id = ?').run(representativeId, row.id);
    }
  }
}

function mergeRating(db, representativeId, duplicateId, representative) {
  const duplicate = db.prepare('SELECT * FROM rating_queue WHERE listing_id = ?').get(duplicateId);
  const current = db.prepare('SELECT * FROM rating_queue WHERE listing_id = ?').get(representativeId);
  if (duplicate && !current) {
    db.prepare('UPDATE rating_queue SET listing_id = ?, notify = 0 WHERE listing_id = ?').run(
      representativeId,
      duplicateId,
    );
  } else if (duplicate) {
    db.prepare(
      `UPDATE rating_queue SET status = 'cancelled', last_error = 'duplicate', updated_at = ?
       WHERE listing_id = ?`,
    ).run(Date.now(), duplicateId);
  }
  const status = representative.manually_deleted || representative.hidden_reason ? 'cancelled' : 'pending';
  db.prepare(
    `UPDATE rating_queue
     SET status = ?, notify = 0, attempt_count = 0, lease_until = NULL,
         next_attempt_at = 0, last_error = NULL, completed_at = NULL,
         updated_at = ?
     WHERE listing_id = ?`,
  ).run(status, Date.now(), representativeId);
}

function compareRepresentative(left, right) {
  return (
    Number(Boolean(left.manually_deleted || left.hidden_reason)) -
      Number(Boolean(right.manually_deleted || right.hidden_reason)) ||
    Number(right.is_active === 1) - Number(left.is_active === 1) ||
    completeness(right) - completeness(left) ||
    Number(left.created_at || 0) - Number(right.created_at || 0) ||
    left.id.localeCompare(right.id)
  );
}

function completeness(listing) {
  return ['title', 'address', 'price', 'size', 'rooms'].reduce(
    (total, key) => total + Number(listing[key] != null && listing[key] !== ''),
    0,
  );
}

function connectMap(map, key, listingId, connect, evidence, tier = 'exact_source') {
  const known = map.get(key);
  if (known) connect(known, listingId, tier, evidence);
  else map.set(key, listingId);
}

function providerListingIdentity(value) {
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
    // Keep malformed historical URLs out of the provider-ID tier.
  }
  return null;
}

function sameSize(left, right) {
  const a = finitePositive(left?.size);
  const b = finitePositive(right?.size);
  return a != null && b != null && Math.abs(a - b) <= 0.1;
}

/** Relative agreement between two positive numbers. */
function withinTolerance(a, b, tolerance) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || left <= 0 || !Number.isFinite(right) || right <= 0) return false;
  return Math.abs(left - right) <= tolerance * Math.max(left, right);
}

/** Two stated, differing room counts mean two different flats. */
function roomsConflict(a, b) {
  const left = Number(a.rooms);
  const right = Number(b.rooms);
  if (!Number.isFinite(left) || left <= 0 || !Number.isFinite(right) || right <= 0) return false;
  return Math.abs(left - right) > 0.01;
}

function priceClose(left, right) {
  const a = finitePositive(left);
  const b = finitePositive(right);
  return a != null && b != null && Math.abs(a - b) <= PRICE_TOLERANCE * Math.max(a, b);
}

function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('de-DE')
    .replace(/[.,;]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function groupBy(values, keyFor) {
  const result = new Map();
  for (const value of values) {
    const key = keyFor(value);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(value);
  }
  return result;
}

function pairKey(left, right) {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function summarize(clusters) {
  const byTier = {};
  for (const cluster of clusters) {
    byTier[cluster.strongestTier] = (byTier[cluster.strongestTier] || 0) + cluster.duplicates.length;
  }
  return {
    clusters: clusters.length,
    listingsInClusters: clusters.reduce((total, cluster) => total + cluster.members.length, 0),
    duplicatesToMerge: clusters.reduce((total, cluster) => total + cluster.duplicates.length, 0),
    byStrongestTier: byTier,
  };
}

class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  root(id) {
    let current = id;
    while (this.parent.get(current) !== current) current = this.parent.get(current);
    let next = id;
    while (this.parent.get(next) !== current) {
      const previous = this.parent.get(next);
      this.parent.set(next, current);
      next = previous;
    }
    return current;
  }

  join(left, right) {
    const a = this.root(left);
    const b = this.root(right);
    if (a !== b) this.parent.set(b, a);
  }

  members(id) {
    const target = this.root(id);
    return [...this.parent.keys()].filter((candidate) => this.root(candidate) === target);
  }
}

export function summarizeCanonicalDuplicates(clusters) {
  return summarize(clusters);
}
