/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Read-only dry run of the pre-LLM deterministic filter tier.
 *
 * Replays the stored detail capture of every listing that ALREADY spent an LLM
 * extraction (canonical_schema_version = current) and was then hidden by a
 * blacklist / specification / area filter, and reports how many of those LLM
 * calls a pre-LLM gate would have avoided. Geocoding is CACHE-ONLY (no network),
 * so it is safe to run against the live database while the app is running.
 *
 *   node tools/pipeline/preLlmDryRun.js
 *
 * Nothing is ever written.
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import SqliteConnection from '../../lib/services/storage/SqliteConnection.js';
import { getJob } from '../../lib/services/storage/jobStorage.js';
import { extractDeterministicDetail } from '../../lib/services/pipeline/deterministicDetail.js';
import { preLlmFilterReasons, primaryFilterReason } from '../../lib/services/pipeline/listingFilters.js';
import { PIPELINE_SCHEMA_VERSION } from '../../lib/services/pipeline/pipelineVersion.js';
import { addressKey } from '../../lib/services/geocoding/address.js';

const REJECTABLE_PRECISION = new Set(
  (process.env.FREDY_PRELLM_AREA_MIN_PRECISION || 'house,street')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
);
const TARGET_REASONS = ['blacklist', 'spec_filter', 'area_filter'];

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || '') ?? fallback;
  } catch {
    return fallback;
  }
}

/** Cache-only area check: never touches the network. */
function areaDeflectsFromCache(db, discovery, deterministic, job) {
  const polygons = job?.spatialFilter?.features?.filter((f) => f.geometry?.type === 'Polygon');
  if (!polygons?.length) return false;
  let lat;
  let lng;
  const coords = deterministic?.coords;
  if (coords?.precision === 'exact' && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
    lat = coords.lat;
    lng = coords.lng;
  } else {
    const address = deterministic?.address?.value || discovery?.address;
    if (!address) return false;
    const row = db
      .prepare(
        "SELECT latitude, longitude, accuracy FROM homeserver_geocode_cache WHERE address_key = ? AND status = 'ok'",
      )
      .get(addressKey(address));
    if (!row || !REJECTABLE_PRECISION.has(row.accuracy)) return false;
    lat = row.latitude;
    lng = row.longitude;
  }
  return !polygons.some((p) => booleanPointInPolygon([lng, lat], p));
}

async function main() {
  await SqliteConnection.init();
  const db = SqliteConnection.getConnection();

  const listings = db
    .prepare(
      `SELECT id, job_id, hidden_reason FROM listings
       WHERE canonical_schema_version = ? AND hidden_reason IN ('blacklist', 'spec_filter', 'area_filter')`,
    )
    .all(PIPELINE_SCHEMA_VERSION);

  const jobs = new Map();
  const jobFor = (id) => {
    if (!jobs.has(id)) jobs.set(id, safeJob(id));
    return jobs.get(id);
  };

  const stats = { considered: 0, noCapture: 0, deflected: 0, byReason: {}, matchedOriginal: 0 };
  for (const reason of TARGET_REASONS) stats.byReason[reason] = { total: 0, deflected: 0 };

  for (const listing of listings) {
    stats.considered++;
    stats.byReason[listing.hidden_reason].total++;
    const source = db
      .prepare(
        `SELECT capture_json, discovery_json FROM listing_sources
         WHERE listing_id = ? AND capture_json IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1`,
      )
      .get(listing.id);
    if (!source) {
      stats.noCapture++;
      continue;
    }
    const capture = parseJson(source.capture_json, {});
    const discovery = parseJson(source.discovery_json, {});
    const job = jobFor(listing.job_id);
    if (!job) continue;

    const deterministic = extractDeterministicDetail(capture, discovery);
    const textReasons = preLlmFilterReasons(capture, discovery, job, deterministic);
    let deflectReason = textReasons.length ? primaryFilterReason(textReasons) : null;
    if (!deflectReason && areaDeflectsFromCache(db, discovery, deterministic, job)) deflectReason = 'area_filter';

    if (deflectReason) {
      stats.deflected++;
      stats.byReason[listing.hidden_reason].deflected++;
      if (deflectReason === listing.hidden_reason) stats.matchedOriginal++;
    }
  }

  const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : '0.0');
  console.log('Pre-LLM deterministic filter — dry run (read-only, cache-only geocoding)\n');
  console.log(`Listings that spent an LLM call then got filtered: ${stats.considered}`);
  console.log(`  without a stored detail capture (cannot replay):  ${stats.noCapture}`);
  console.log(
    `  would be deflected pre-LLM:                        ${stats.deflected} (${pct(stats.deflected, stats.considered)}%)`,
  );
  console.log(`  deflected with the same reason:                    ${stats.matchedOriginal}\n`);
  for (const reason of TARGET_REASONS) {
    const r = stats.byReason[reason];
    console.log(
      `  ${reason.padEnd(12)} total ${String(r.total).padStart(5)}  deflected ${String(r.deflected).padStart(5)} (${pct(r.deflected, r.total)}%)`,
    );
  }
  SqliteConnection.close();
}

function safeJob(id) {
  try {
    return getJob(id);
  } catch {
    return null;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
