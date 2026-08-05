/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import { listingAttributes } from '../listings/attributes.js';
import { claimsForListing, geocodeAccuracyFor, providerListingIdentity } from '../listings/claims.js';
import {
  CanonicalFacts,
  canonicalFilterReasons,
  primaryFilterReason,
  primaryFilterStage,
} from '../pipeline/listingFilters.js';
import { enqueueNotification } from '../pipeline/notificationOutbox.js';
import { enqueueRating } from '../pipeline/ratingQueue.js';
import { filterConfigHash, recordVerdict } from '../pipeline/terminalVerdict.js';
import { getJob } from '../storage/jobStorage.js';
import { nanoid } from 'nanoid';

const WARM_MARKERS = /warmmiete|gesamtmiete|bruttomiete|inkl\.?\s*nebenkosten|inklusive\s+nebenkosten/iu;
const COLD_MARKERS = /kaltmiete|nettokaltmiete|nettomiete|zzgl\.?\s*(nebenkosten|nk)\b/iu;

export function runHistoricalBackfill(db) {
  const summary = {};
  for (const [marker, pass] of [
    ['backfill_rent_conflation', repairConflatedRents],
    ['backfill_legacy_sources', synthesiseLegacySources],
    ['backfill_geo_claims', remintGeoClaims],
    ['backfill_legacy_verdicts', redecideLegacyVerdicts],
    ['backfill_score_backlog', enqueueScoreBacklog],
    ['backfill_notify_stragglers', enqueueNotifyStragglers],
  ]) {
    if (isDone(db, marker)) continue;
    try {
      const touched = pass(db);
      markDone(db, marker, touched);
      summary[marker] = touched;
      logger.info(`Backfill '${marker}' touched ${touched} row(s).`);
    } catch (error) {
      logger.event('backfill_pass_failed', 'error', `Backfill '${marker}' failed; will retry next pass.`, error);
    }
  }
  return summary;
}

function isDone(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM pipeline_control WHERE name = ?`).get(name));
}

function markDone(db, name, touched) {
  db.prepare(
    `INSERT INTO pipeline_control (name, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(name, String(touched), Date.now());
}

function repairConflatedRents(db) {
  const rows = db
    .prepare(
      `SELECT e.queue_id, e.llm_json, s.listing_id, t.full_text
       FROM listing_extractions e
       JOIN listing_sources s ON s.parsing_queue_id = e.queue_id
       LEFT JOIN listing_texts t ON t.listing_id = s.listing_id
       WHERE e.llm_json IS NOT NULL AND s.listing_id IS NOT NULL`,
    )
    .all();

  const updateLlm = db.prepare(`UPDATE listing_extractions SET llm_json = ? WHERE queue_id = ?`);
  const updateAttrs = db.prepare(`UPDATE listing_attributes SET data = ? WHERE listing_id = ?`);
  const readAttrs = db.prepare(`SELECT data FROM listing_attributes WHERE listing_id = ?`);
  const seen = new Set();
  let repaired = 0;

  db.transaction(() => {
    for (const row of rows) {
      let llm;
      try {
        llm = JSON.parse(row.llm_json);
      } catch {
        continue;
      }
      const cold = llm?.rent?.cold;
      const warm = llm?.rent?.warm;
      if (!(cold > 0) || !(warm > 0) || Math.abs(cold - warm) >= 0.01) continue;

      const text = row.full_text || '';
      const saysColdOnly = COLD_MARKERS.test(text) && !WARM_MARKERS.test(text);
      if (saysColdOnly) continue;
      llm.rent.cold = null;
      updateLlm.run(JSON.stringify(llm), row.queue_id);

      if (!seen.has(row.listing_id)) {
        seen.add(row.listing_id);
        const stored = readAttrs.get(row.listing_id);
        if (stored) {
          let attrs;
          try {
            attrs = JSON.parse(stored.data || '{}');
          } catch {
            attrs = null;
          }
          if (attrs && typeof attrs === 'object') {
            attrs.coldRentEur = null;
            attrs.priceType = 'warm';
            updateAttrs.run(JSON.stringify(attrs), row.listing_id);
          }
        }
        repaired += 1;
      }
    }
  })();
  return repaired;
}

function synthesiseLegacySources(db) {
  const rows = db
    .prepare(
      `SELECT l.id, l.provider, l.link, v.job_id
       FROM listings l
       JOIN listing_verdicts v ON v.listing_id = l.id
       WHERE l.link IS NOT NULL AND l.link != ''
         AND NOT EXISTS (SELECT 1 FROM listing_sources s WHERE s.listing_id = l.id)`,
    )
    .all();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO listing_sources
       (id, job_id, provider, source_key, source_url, listing_id, dedupe_keys_json, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
  );
  let created = 0;
  db.transaction(() => {
    for (const row of rows) {
      const key = providerListingIdentity(row.link) || row.link;
      created += insert.run(nanoid(), row.job_id, row.provider, key, row.link, row.id, 0, 0).changes;
    }
  })();
  return created;
}

function remintGeoClaims(db) {
  db.prepare(`DELETE FROM listing_claims WHERE kind = 'geo'`).run();
  const rows = db
    .prepare(
      `SELECT id, title, address, price, size, rooms, latitude, longitude, link
       FROM listings
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND size > 0`,
    )
    .all();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO listing_claims (claim, listing_id, source_id, kind, first_seen_at)
     VALUES (?, ?, NULL, 'geo', ?)`,
  );
  const now = Date.now();
  let minted = 0;
  db.transaction(() => {
    for (const row of rows) {
      const accuracy = geocodeAccuracyFor(db, row.address);
      if (!accuracy) continue;
      const claims = claimsForListing({ ...row, geocodeAccuracy: accuracy }).filter((c) => c.kind === 'geo');
      for (const { claim } of claims) minted += insert.run(claim, row.id, now).changes;
    }
  })();
  return minted;
}

function redecideLegacyVerdicts(db) {
  const rows = db
    .prepare(`SELECT DISTINCT v.listing_id, v.job_id FROM listing_verdicts v WHERE v.config_hash IS NULL`)
    .all();
  const listing = db.prepare(
    `SELECT l.id, l.title, l.address, l.price, l.size, l.rooms, l.latitude, l.longitude, a.data
     FROM listings l LEFT JOIN listing_attributes a ON a.listing_id = l.id WHERE l.id = ?`,
  );
  const stampNotified = db.prepare(
    `UPDATE listing_verdicts SET notified_at = COALESCE(notified_at, decided_at)
     WHERE listing_id = ? AND job_id = ? AND verdict = 'accepted'`,
  );
  const jobs = new Map();
  let decided = 0;

  db.transaction(() => {
    for (const row of rows) {
      if (!jobs.has(row.job_id)) jobs.set(row.job_id, getJob(row.job_id));
      const job = jobs.get(row.job_id);
      const stored = listing.get(row.listing_id);
      if (!job || !stored) continue;
      const facts = new CanonicalFacts({ ...stored, attributes: listingAttributes(stored.data) });
      const reasons = canonicalFilterReasons(facts, job);
      const reason = primaryFilterReason(reasons);
      recordVerdict(db, {
        listingId: row.listing_id,
        jobId: row.job_id,
        verdict: reason ? 'rejected' : 'accepted',
        reason,
        stage: primaryFilterStage(reasons) ?? 'extraction',
        configHash: filterConfigHash(job),
      });
      if (!reason) stampNotified.run(row.listing_id, row.job_id);
      decided += 1;
    }
  })();
  return decided;
}

function enqueueScoreBacklog(db) {
  const rows = db
    .prepare(
      `SELECT l.id, l.provider, (SELECT v.job_id FROM listing_verdicts v WHERE v.listing_id = l.id LIMIT 1) job_id
       FROM listings l JOIN listing_attributes a ON a.listing_id = l.id
       WHERE l.state = 'active' AND l.price > 0 AND l.size BETWEEN 10 AND 400
         AND json_extract(a.data, '$.priceType') = 'cold'
         AND NOT EXISTS (SELECT 1 FROM homeserver_listing_model_scores s WHERE s.listing_id = l.id)`,
    )
    .all();
  for (const row of rows) {
    if (!row.job_id) continue;
    enqueueRating(row.id, row.job_id, row.provider, { notify: false });
  }
  return rows.length;
}

function enqueueNotifyStragglers(db) {
  const rows = db
    .prepare(
      `SELECT v.listing_id, v.job_id, l.provider FROM listing_verdicts v
       JOIN listings l ON l.id = v.listing_id
       WHERE v.verdict = 'accepted' AND v.notified_at IS NULL AND l.state = 'active'`,
    )
    .all();
  let queued = 0;
  for (const row of rows) {
    const job = getJob(row.job_id);
    if (!job) continue;
    enqueueNotification(row.listing_id, job, row.provider);
    queued += 1;
  }
  return queued;
}
