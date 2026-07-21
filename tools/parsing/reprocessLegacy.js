/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * One-time reconciliation of pre-v4 (legacy / v3-residue) listings to a single,
 * clean, current-standard state — so "everything is v4".
 *
 * For every listing not yet at the canonical schema version:
 *   - No detail evidence captured  -> terminal, hidden_reason='no_detail', no LLM.
 *   - Has detail evidence          -> re-run the CURRENT pre-LLM filters
 *       (blacklist + specification on stored/deterministic facts, area on the
 *        stored coordinates). If it now fails a filter, it is marked terminal
 *        with that ONE current reason (no LLM). If it passes, it is enqueued for
 *        a fresh LLM extraction, i.e. treated exactly as if it just came in.
 *
 * Stale legacy blacklist/spec/area tags and v3 attribute rows are cleared, so
 * each listing ends with exactly one reason under today's rules. Uses stored
 * coordinates (no geocoding) and is fully synchronous. Idempotent: already-v4
 * listings are skipped, so re-running is safe.
 *
 *   node tools/parsing/reprocessLegacy.js           # dry run (default)
 *   node tools/parsing/reprocessLegacy.js apply      # mutate
 */

import SqliteConnection from '../../lib/services/storage/SqliteConnection.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { refreshConfig } from '../../lib/utils.js';
import { getJob } from '../../lib/services/storage/jobStorage.js';
import { classifyLegacyListing } from '../../lib/services/pipeline/legacyReprocess.js';
import { enqueueCapture, PIPELINE_SCHEMA_VERSION } from '../../lib/services/pipeline/queueStorage.js';

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || '') ?? fallback;
  } catch {
    return fallback;
  }
}

function run({ apply }) {
  const db = SqliteConnection.getConnection();
  const listings = db
    .prepare(
      `SELECT l.* FROM listings l
       LEFT JOIN listing_attributes a ON a.listing_id = l.id
       WHERE COALESCE(l.canonical_schema_version, 0) < @v AND COALESCE(a.schema_version, 0) < @v
       ORDER BY l.created_at ASC`,
    )
    .all({ v: PIPELINE_SCHEMA_VERSION });

  const sourceStmt = db.prepare(
    `SELECT capture_json, discovery_json FROM listing_sources
     WHERE listing_id = ? AND capture_json IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1`,
  );
  const markTerminal = db.prepare(
    `UPDATE listings SET canonical_schema_version = @v, manually_deleted = 1, hidden_reason = @reason,
       filter_reasons_json = @reasons WHERE id = @id`,
  );
  const clearAttrs = db.prepare(`DELETE FROM listing_attributes WHERE listing_id = ?`);
  const jobs = new Map();
  const jobFor = (id) => {
    if (!jobs.has(id)) {
      try {
        jobs.set(id, getJob(id));
      } catch {
        jobs.set(id, null);
      }
    }
    return jobs.get(id);
  };

  const stats = { total: listings.length, terminal: {}, reprocess: 0 };
  const apply_ = db.transaction(() => {
    for (const listing of listings) {
      const source = sourceStmt.get(listing.id);
      const capture = source ? parseJson(source.capture_json, null) : null;
      const sourceDiscovery = source ? parseJson(source.discovery_json, {}) : {};
      const discovery = {
        title: listing.title,
        description: listing.description,
        address: listing.address,
        price: listing.price,
        size: listing.size,
        rooms: listing.rooms,
        ...sourceDiscovery,
      };
      const job = jobFor(listing.job_id);
      const verdict = classifyLegacyListing({ listing, capture, discovery, job });

      if (verdict.action === 'terminal') {
        stats.terminal[verdict.reason] = (stats.terminal[verdict.reason] || 0) + 1;
        if (apply) {
          markTerminal.run({
            v: PIPELINE_SCHEMA_VERSION,
            reason: verdict.reason,
            reasons: JSON.stringify([{ code: verdict.reason, stage: 'reprocess' }]),
            id: listing.id,
          });
          clearAttrs.run(listing.id);
        }
      } else {
        stats.reprocess += 1;
        if (apply) {
          enqueueCapture({
            jobId: listing.job_id,
            provider: listing.provider,
            sourceHash: listing.hash,
            capture,
            images: [],
            queueKind: 'backfill',
            listingId: listing.id,
          });
        }
      }
    }
  });
  apply_();
  return stats;
}

// --- CLI ---------------------------------------------------------------------

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const apply = process.argv[2] === 'apply';
  await SqliteConnection.init();
  await refreshConfig();
  await runMigrations();
  const stats = run({ apply });
  const mode = apply ? 'APPLIED' : 'DRY RUN (no changes)';
  process.stdout.write(`Legacy reprocess — ${mode}\n`);
  process.stdout.write(`  candidates (pre-v${PIPELINE_SCHEMA_VERSION}): ${stats.total}\n`);
  process.stdout.write(`  -> terminal (single current reason, no LLM):\n`);
  for (const [reason, n] of Object.entries(stats.terminal).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`       ${reason.padEnd(18)} ${n}\n`);
  }
  process.stdout.write(`  -> reprocess (enqueued for fresh LLM): ${stats.reprocess}\n`);
  SqliteConnection.close();
}
