/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../../lib/services/storage/SqliteConnection.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { refreshConfig } from '../../lib/utils.js';
import {
  enqueueCapture,
  getBackfillStatus,
  PIPELINE_SCHEMA_VERSION,
  setBackfillPaused,
} from '../../lib/services/pipeline/queueStorage.js';

await SqliteConnection.init();
await refreshConfig();
await runMigrations();

const command = process.argv[2] || 'status';
if (command === 'enqueue') enqueueAll();
else if (command === 'pause') setBackfillPaused(true);
else if (command === 'resume') setBackfillPaused(false);
else if (command !== 'status') {
  process.stderr.write('Usage: yarn parsing:backfill <enqueue|status|pause|resume>\n');
  process.exitCode = 1;
}

process.stdout.write(`${JSON.stringify(getBackfillStatus(), null, 2)}\n`);

/**
 * Enqueue a text-only backfill parse for every supported listing that does
 * not yet have an extraction under the current pipeline schema. The original
 * live capture (full page text, embedded data) is reused as parser input
 * whenever it is still available; otherwise the capture is reconstructed
 * from the stored listing row. Enqueueing under the current schema version
 * automatically supersedes any unfinished rows from older versions.
 */
function enqueueAll() {
  const db = SqliteConnection.getConnection();
  const rows = db
    .prepare(
      `SELECT l.*
       FROM listings l
       WHERE l.provider IN ('immoscout', 'immowelt', 'wgGesucht', 'kleinanzeigen')
         AND NOT EXISTS (
           SELECT 1 FROM listing_extractions e
           WHERE e.listing_id = l.id AND e.schema_version >= @schemaVersion AND e.llm_json IS NOT NULL
         )
       ORDER BY l.created_at ASC`,
    )
    .all({ schemaVersion: PIPELINE_SCHEMA_VERSION });

  const captureLookup = db.prepare(
    `SELECT capture_json FROM parsing_queue
     WHERE job_id = ? AND provider = ? AND source_hash = ? AND capture_json IS NOT NULL
     ORDER BY schema_version DESC, updated_at DESC LIMIT 1`,
  );

  let enqueued = 0;
  for (const row of rows) {
    const capture = buildCapture(row, captureLookup.get(row.job_id, row.provider, row.hash)?.capture_json);
    const queueId = enqueueCapture({
      jobId: row.job_id,
      provider: row.provider,
      sourceHash: row.hash,
      capture,
      images: [],
      queueKind: 'backfill',
      listingId: row.id,
    });
    if (queueId) enqueued++;
  }
  process.stdout.write(
    `Backfill queue contains ${enqueued} listings pending re-extraction for schema v${PIPELINE_SCHEMA_VERSION}.\n`,
  );
}

/**
 * Prefer the originally captured evidence over a reconstruction from the
 * trimmed listing row — the live capture carries the full page text and
 * embedded provider data, which is strictly better parser input.
 *
 * @param {object} row listings row
 * @param {string|undefined} originalCaptureJson capture_json of a previous queue row
 * @returns {object} capture for enqueueCapture
 */
function buildCapture(row, originalCaptureJson) {
  if (originalCaptureJson) {
    try {
      const original = JSON.parse(originalCaptureJson);
      if (original?.fullText) {
        return { ...original, images: [], backfillSchemaVersion: PIPELINE_SCHEMA_VERSION };
      }
    } catch {
      // fall through to reconstruction
    }
  }
  return {
    provider: row.provider,
    externalId: row.hash,
    sourceUrl: row.link,
    discoveredAt: row.created_at || Date.now(),
    discoveryData: {
      id: row.hash,
      link: row.link,
      title: row.title,
      price: row.price,
      size: row.size,
      rooms: row.rooms,
      address: row.address,
      image: row.image_url,
      description: row.description,
    },
    fullText: row.description || '',
    embeddedData: [],
    images: [],
    backfillSchemaVersion: PIPELINE_SCHEMA_VERSION,
  };
}
