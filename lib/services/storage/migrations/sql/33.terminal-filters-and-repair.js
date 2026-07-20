/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';

/**
 * Make filtering terminal, repair challenge-page dedupe damage, collapse
 * redundant unfinished parses, and keep unscored accepted listings waiting
 * durably for the next compatible market model.
 */
export function up(db) {
  const now = Date.now();
  addColumn(db, 'listings', "filter_reasons_json TEXT NOT NULL DEFAULT '[]'");
  rebuildRatingQueue(db);

  const jobs = new Map(
    db
      .prepare('SELECT id, blacklist, spec_filter, spatial_filter FROM jobs')
      .all()
      .map((row) => [
        row.id,
        {
          blacklist: parse(row.blacklist, []),
          specFilter: parse(row.spec_filter, null),
          spatialFilter: parse(row.spatial_filter, null),
        },
      ]),
  );

  repairChallengeMerges(db, now);
  filterHistoricalDetails(db, jobs, now);
  filterHistoricalParsing(db, jobs, now);
  filterCanonicalListings(db, jobs, now);
  collapseActiveParsing(db, now);
  cancelHiddenWork(db, now);
  ensureCanonicalMigration(db, now);
  ensureRatingWork(db, now);
}

function rebuildRatingQueue(db) {
  db.exec(`
    ALTER TABLE rating_queue RENAME TO rating_queue_old;
    CREATE TABLE rating_queue (
      listing_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      notify INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'retry', 'completed', 'waiting_model', 'unrated', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (listing_id) REFERENCES listings (id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
    );
    INSERT INTO rating_queue
    SELECT listing_id, job_id, provider, notify,
      CASE WHEN status = 'unrated' THEN 'waiting_model' ELSE status END,
      attempt_count, lease_until, next_attempt_at, last_error,
      created_at, updated_at, completed_at
    FROM rating_queue_old;
    DROP TABLE rating_queue_old;
    CREATE INDEX idx_rating_queue_due
      ON rating_queue (status, next_attempt_at, lease_until);
  `);
}

function repairChallengeMerges(db, now) {
  const sources = db.prepare('SELECT * FROM listing_sources').all();
  const challengeIds = new Set(
    sources.filter((source) => isChallenge(textFromJson(source.capture_json))).map((source) => source.id),
  );
  if (!challengeIds.size) return;
  const affected = sources.filter(
    (source) => challengeIds.has(source.id) || challengeIds.has(source.representative_source_id),
  );
  const affectedListings = new Set(affected.map((source) => source.listing_id).filter(Boolean));
  const resetDetail = db.prepare(
    `UPDATE detail_fetch_queue
     SET source_url = ?, discovery_json = ?, discovery_hash = ?, capture_json = NULL,
         status = 'pending', attempt_count = 0, lease_until = NULL, next_attempt_at = 0,
         last_error = NULL, capture_queue_id = NULL, completed_at = NULL, updated_at = ?
     WHERE id = ?`,
  );
  const insertDetail = db.prepare(
    `INSERT INTO detail_fetch_queue (
       id, job_id, provider, source_key, external_id, source_url, discovery_json,
       discovery_hash, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  );
  const updateSource = db.prepare(
    `UPDATE listing_sources
     SET source_url = ?, detail_queue_id = ?, parsing_queue_id = NULL, listing_id = NULL,
         representative_source_id = NULL, dedupe_stage = NULL, dedupe_keys_json = ?,
         pre_llm_hidden_reason = NULL, post_llm_hidden_reason = NULL, last_seen_at = ?
     WHERE id = ?`,
  );

  for (const source of affected) {
    const discovery = parse(source.discovery_json, {});
    const sourceUrl = canonicalUrl(discovery.link || source.source_url);
    discovery.link = discovery.link || sourceUrl;
    const discoveryJson = JSON.stringify(discovery);
    const discoveryHash = hashStableDiscovery(discovery);
    if (source.parsing_queue_id) {
      db.prepare(
        `UPDATE parsing_queue SET status = 'cancelled', lease_until = NULL, completed_at = ?,
         updated_at = ?, last_error = 'Bot challenge was not listing details'
         WHERE id = ? AND status IN ('pending', 'retry', 'processing')`,
      ).run(now, now, source.parsing_queue_id);
    }
    let detail = db
      .prepare('SELECT id FROM detail_fetch_queue WHERE job_id = ? AND provider = ? AND source_key = ?')
      .get(source.job_id, source.provider, source.source_key);
    if (detail) {
      resetDetail.run(sourceUrl, discoveryJson, discoveryHash, now, detail.id);
    } else {
      detail = { id: `repair:${source.id}` };
      insertDetail.run(
        detail.id,
        source.job_id,
        source.provider,
        source.source_key,
        discovery.externalId ?? discovery.id ?? null,
        sourceUrl,
        discoveryJson,
        discoveryHash,
        now,
        now,
      );
    }
    updateSource.run(sourceUrl, detail.id, JSON.stringify(sourceUrl ? [`url:${sourceUrl}`] : []), now, source.id);
    audit(db, source.id, null, detail.id, 'migration_repair', 'requeued', 'Bot challenge was not listing details', {
      previousListingId: source.listing_id,
      previousRepresentativeSourceId: source.representative_source_id,
    });
  }
  for (const listingId of affectedListings) {
    markFiltered(db, listingId, [{ code: 'invalid_detail_capture', stage: 'historical_repair' }], now);
  }
}

function filterHistoricalDetails(db, jobs, now) {
  const rows = db.prepare("SELECT * FROM detail_fetch_queue WHERE status IN ('pending', 'retry', 'processing')").all();
  for (const row of rows) {
    const discovery = parse(row.discovery_json, {});
    const capture = parse(row.capture_json, {});
    const reasons = preReasons(capture, discovery, jobs.get(row.job_id));
    if (!reasons.length) continue;
    const listingId = ensureAuditListing(db, row, discovery, capture, reasons, now);
    db.prepare('UPDATE listing_sources SET listing_id = ?, pre_llm_hidden_reason = ? WHERE detail_queue_id = ?').run(
      listingId,
      reasons[0].code,
      row.id,
    );
    markFiltered(db, listingId, reasons, now);
  }
}

function filterHistoricalParsing(db, jobs, now) {
  const rows = db
    .prepare(
      `SELECT * FROM parsing_queue
       WHERE schema_version = 4 AND status IN ('pending', 'retry', 'processing')`,
    )
    .all();
  for (const row of rows) {
    const capture = parse(row.capture_json, {});
    const discovery = capture.discoveryData || {};
    const reasons = preReasons(capture, discovery, jobs.get(row.job_id));
    const knownHidden = row.listing_id
      ? db.prepare('SELECT manually_deleted FROM listings WHERE id = ?').get(row.listing_id)?.manually_deleted
      : false;
    if (!reasons.length && !knownHidden) continue;
    let listingId = row.listing_id;
    if (!listingId && reasons.length) listingId = ensureAuditListing(db, row, discovery, capture, reasons, now);
    if (listingId && reasons.length) {
      db.prepare(
        `UPDATE listing_sources SET listing_id = ?, pre_llm_hidden_reason = ?
         WHERE parsing_queue_id = ?`,
      ).run(listingId, reasons[0].code, row.id);
      refreshListingUrls(db, listingId);
      markFiltered(db, listingId, reasons, now);
    }
    db.prepare(
      `UPDATE parsing_queue SET listing_id = COALESCE(listing_id, ?), status = 'cancelled',
       lease_until = NULL, completed_at = ?, updated_at = ?, last_error = ? WHERE id = ?`,
    ).run(listingId, now, now, reasons[0]?.code || 'Listing already manually deleted', row.id);
  }
}

function filterCanonicalListings(db, jobs, now) {
  const rows = db.prepare('SELECT * FROM listings WHERE canonical_schema_version >= 4 AND manually_deleted = 0').all();
  for (const row of rows) {
    const reasons = postReasons(row, jobs.get(row.job_id));
    if (reasons.length) markFiltered(db, row.id, reasons, now);
  }
}

function collapseActiveParsing(db, now) {
  const rows = db
    .prepare(
      `SELECT * FROM parsing_queue
       WHERE schema_version = 4 AND status IN ('pending', 'retry', 'processing')
       ORDER BY created_at ASC`,
    )
    .all();
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.job_id}\u0000${row.provider}\u0000${canonicalUrl(row.source_url) || row.external_id || row.source_hash}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const survivor = group.find((row) => row.queue_kind === 'backfill' && row.listing_id) || group.at(-1);
    const newest = group.at(-1);
    if (survivor.status !== 'processing' && newest.capture_json) {
      db.prepare('UPDATE parsing_queue SET capture_json = ?, source_url = ?, updated_at = ? WHERE id = ?').run(
        newest.capture_json,
        newest.source_url,
        now,
        survivor.id,
      );
    }
    for (const row of group) {
      if (row.id === survivor.id) continue;
      db.prepare(
        `UPDATE parsing_queue SET status = 'cancelled', lease_until = NULL, completed_at = ?,
         updated_at = ?, last_error = 'Superseded by stable source queue ' || ? WHERE id = ?`,
      ).run(now, now, survivor.id, row.id);
      db.prepare('UPDATE listing_sources SET parsing_queue_id = ? WHERE parsing_queue_id = ?').run(survivor.id, row.id);
      audit(
        db,
        null,
        row.listing_id,
        row.id,
        'migration_repair',
        'cancelled_redundant',
        'Stable source already queued',
        {
          survivorQueueId: survivor.id,
        },
      );
    }
  }
}

function cancelHiddenWork(db, now) {
  db.prepare(
    `UPDATE parsing_queue
     SET status = 'cancelled', lease_until = NULL, completed_at = ?, updated_at = ?,
         last_error = 'Listing manually deleted'
     WHERE status IN ('pending', 'retry', 'processing') AND (
       listing_id IN (SELECT id FROM listings WHERE manually_deleted = 1)
       OR id IN (
         SELECT s.parsing_queue_id FROM listing_sources s
         JOIN listings l ON l.id = s.listing_id
         WHERE l.manually_deleted = 1 AND s.parsing_queue_id IS NOT NULL
       )
     )`,
  ).run(now, now);
  db.prepare(
    `UPDATE detail_fetch_queue
     SET status = 'cancelled', lease_until = NULL, completed_at = ?, updated_at = ?,
         last_error = 'Listing manually deleted'
     WHERE status IN ('pending', 'retry', 'processing') AND id IN (
       SELECT s.detail_queue_id FROM listing_sources s
       JOIN listings l ON l.id = s.listing_id
       WHERE l.manually_deleted = 1 AND s.detail_queue_id IS NOT NULL
     )`,
  ).run(now, now);
  db.prepare(
    `UPDATE rating_queue
     SET status = 'cancelled', lease_until = NULL, completed_at = ?, updated_at = ?,
         last_error = 'Listing manually deleted'
     WHERE listing_id IN (SELECT id FROM listings WHERE manually_deleted = 1)`,
  ).run(now, now);
  db.prepare(
    `UPDATE notification_deliveries SET status = 'cancelled', last_error = 'Listing manually deleted'
     WHERE status = 'pending' AND listing_id IN (SELECT id FROM listings WHERE manually_deleted = 1)`,
  ).run();
}

function ensureCanonicalMigration(db, now) {
  const listings = db
    .prepare(
      `SELECT l.* FROM listings l
       WHERE l.manually_deleted = 0 AND l.canonical_schema_version < 4
         AND NOT EXISTS (
           SELECT 1 FROM parsing_queue q
           WHERE q.listing_id = l.id AND q.schema_version = 4 AND q.status != 'cancelled'
         )`,
    )
    .all();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO parsing_queue (
       id, queue_kind, schema_version, job_id, provider, source_hash, listing_id,
       external_id, source_url, discovered_at, capture_json, stage, status,
       created_at, updated_at
     ) VALUES (?, 'backfill', 4, ?, ?, ?, ?, ?, ?, ?, ?, 'captured', 'pending', ?, ?)`,
  );
  for (const listing of listings) {
    const capture = {
      provider: listing.provider,
      externalId: listing.hash || listing.id,
      sourceUrl: listing.link,
      discoveredAt: listing.created_at || now,
      rawText: listing.description || '',
      fullText: listing.description || '',
      embeddedData: [],
      images: [],
      evidenceStatus: 'historical_backfill',
    };
    insert.run(
      crypto.randomUUID(),
      listing.job_id,
      listing.provider,
      listing.hash || listing.id,
      listing.id,
      listing.hash || listing.id,
      listing.link,
      listing.created_at || now,
      JSON.stringify(capture),
      now,
      now,
    );
  }
}

function ensureRatingWork(db, now) {
  db.prepare(
    `INSERT OR IGNORE INTO rating_queue (
       listing_id, job_id, provider, notify, status, created_at, updated_at
     )
     SELECT l.id, l.job_id, l.provider, 0, 'pending', ?, ?
     FROM listings l JOIN listing_attributes a ON a.listing_id = l.id
     WHERE l.manually_deleted = 0 AND l.is_active != 0 AND a.schema_version >= 4`,
  ).run(now, now);
}

function markFiltered(db, listingId, reasons) {
  if (!listingId) return;
  const reason = reasons[0]?.code || 'filtered';
  db.prepare(
    `UPDATE listings SET manually_deleted = 1, hidden_reason = COALESCE(hidden_reason, ?),
     filter_reasons_json = ? WHERE id = ?`,
  ).run(reason, JSON.stringify(reasons), listingId);
  audit(db, null, listingId, null, 'historical_filter', 'soft_deleted', reason, { reasons });
}

function ensureAuditListing(db, row, discovery, capture, reasons, now) {
  const jobId = row.job_id;
  const hash = row.source_hash || row.discovery_hash || `filter:${row.id}`;
  let listing = db.prepare('SELECT id FROM listings WHERE job_id = ? AND hash = ?').get(jobId, hash);
  if (listing) return listing.id;
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO listings (
       id, hash, provider, job_id, price, size, rooms, title, image_url, description,
       address, link, created_at, is_active, manually_deleted, hidden_reason,
       canonical_schema_version, source_urls_json, filter_reasons_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 0, ?, ?)`,
  ).run(
    id,
    hash,
    row.provider,
    jobId,
    finite(discovery.price),
    finite(discovery.size),
    finite(discovery.rooms),
    discovery.title || '',
    discovery.image || null,
    capture.fullText || discovery.description || '',
    discovery.address || null,
    discovery.link || row.source_url || null,
    discovery.discoveredAt || row.discovered_at || row.created_at || now,
    reasons[0].code,
    JSON.stringify([discovery.link || row.source_url].filter(Boolean)),
    JSON.stringify(reasons),
  );
  return id;
}

function preReasons(capture, discovery, job) {
  const reasons = [];
  const text = [evidenceText(capture?.fullText), discovery?.title, discovery?.description, discovery?.address]
    .filter(Boolean)
    .join('\n');
  if (matchesAny(text, job?.blacklist || [])) reasons.push({ code: 'blacklist_pre_llm', stage: 'pre_llm' });
  reasons.push(...specReasons(discovery, job?.specFilter, 'pre_llm'));
  return reasons;
}

function postReasons(listing, job) {
  const reasons = [];
  const text = [listing.title, evidenceText(listing.description), listing.address].filter(Boolean).join('\n');
  if (matchesAny(text, job?.blacklist || [])) reasons.push({ code: 'blacklist', stage: 'post_llm' });
  reasons.push(...specReasons(listing, job?.specFilter, 'post_llm'));
  const polygons = job?.spatialFilter?.features?.filter((feature) => feature.geometry?.type === 'Polygon');
  if (polygons?.length) {
    const lat = Number(listing.latitude);
    const lng = Number(listing.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) reasons.push({ code: 'no_coordinates', stage: 'post_llm' });
    else if (!polygons.some((feature) => pointInPolygon(lng, lat, feature.geometry.coordinates))) {
      reasons.push({ code: 'area_filter', stage: 'post_llm' });
    }
  }
  return reasons;
}

function specReasons(values, spec, stage) {
  const reasons = [];
  const checks = [
    ['rooms', finite(values?.rooms), finite(spec?.minRooms), (a, b) => a < b],
    ['size', finite(values?.size ?? values?.size_sqm), finite(spec?.minSize), (a, b) => a < b],
    ['price', finite(values?.price), finite(spec?.maxPrice), (a, b) => a > b],
  ];
  for (const [field, actual, required, fails] of checks) {
    if (actual != null && required != null && fails(actual, required)) {
      reasons.push({ code: 'spec_filter', stage, field, actual, required });
    }
  }
  return reasons;
}

function matchesAny(value, terms) {
  const haystack = String(value || '').toLocaleLowerCase('de-DE');
  return terms.some((value) => {
    const term = String(value || '')
      .trim()
      .toLocaleLowerCase('de-DE');
    if (!term) return false;
    if (term === 'wg') {
      const token = /(^|[^\p{L}\p{N}])(wg|wohngemeinschaft)([^\p{L}\p{N}]|$)/iu;
      const negative = /(^|[^\p{L}\p{N}])(kein|keine|keinen|nicht)\s+(wg|wohngemeinschaft)([^\p{L}\p{N}]|$)/iu;
      return token.test(haystack) && !negative.test(haystack);
    }
    if (term === 'befristet') return /(^|[^\p{L}\p{N}])befristet([^\p{L}\p{N}]|$)/iu.test(haystack);
    return haystack.includes(term);
  });
}

function evidenceText(value) {
  return String(value || '').replace(/\bWG-Gesucht(?:\.de)?\b/giu, '');
}

function isChallenge(value) {
  return [
    /verify you are human/i,
    /access denied/i,
    /bitte best[aä]tigen sie,? dass sie ein mensch sind/i,
    /best[aä]tigen.{0,80}(mensch|kein roboter)/i,
    /captcha/i,
    /challenge-platform/i,
    /cf-chl-/i,
  ].some((pattern) => pattern.test(value));
}

function textFromJson(value) {
  const parsed = parse(value, {});
  return `${parsed.rawText || ''}\n${parsed.fullText || ''}`;
}

function canonicalUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|ref|referrer|tracking|trackingId)$/iu.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value).trim();
  }
}

function pointInPolygon(x, y, polygons) {
  const ring = polygons?.[0] || [];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function hashStableDiscovery(discovery) {
  const copy = { ...discovery };
  delete copy.discoveredAt;
  return crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

function audit(db, sourceId, listingId, queueId, stage, action, reason, payload) {
  db.prepare(
    `INSERT INTO pipeline_audit_events (
       source_id, listing_id, queue_id, stage, action, reason, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sourceId, listingId, queueId, stage, action, reason, JSON.stringify(payload || {}), Date.now());
}

function refreshListingUrls(db, listingId) {
  const listing = db.prepare('SELECT link, source_urls_json FROM listings WHERE id = ?').get(listingId);
  if (!listing) return;
  const stored = parse(listing.source_urls_json, []);
  const sources = db.prepare('SELECT source_url FROM listing_sources WHERE listing_id = ?').all(listingId);
  const urls = [listing.link, ...(Array.isArray(stored) ? stored : []), ...sources.map((row) => row.source_url)]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
  db.prepare('UPDATE listings SET source_urls_json = ? WHERE id = ?').run(
    JSON.stringify([...new Set(urls)]),
    listingId,
  );
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parse(value, fallback) {
  try {
    return JSON.parse(value || '') ?? fallback;
  } catch {
    return fallback;
  }
}

function addColumn(db, table, definition) {
  const name = definition.split(/\s+/)[0];
  const exists = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((column) => column.name === name);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}
