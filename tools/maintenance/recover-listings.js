/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

#!/usr/bin/env node
/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Database from 'better-sqlite3';
import SqliteConnection, { computeDbPath } from '../../lib/services/storage/SqliteConnection.js';
import { refreshConfig } from '../../lib/utils.js';
import logger from '../../lib/services/logger.js';

/*
 * Carry extracted listings out of a pre-verdict snapshot into the current
 * schema.
 *
 * The migration discards the listing corpus rather than converting it, because
 * almost all of it is adverts for flats that were let months ago and the running
 * system re-decides everything from scratch anyway. One part is worth keeping:
 * the listings the model actually read. They are what the market models train
 * on, and unlike a live advert they cannot be re-discovered — a flat that is off
 * the market is off the market, and its price is only recorded here.
 *
 * So this restores exactly that: rows with a stored extraction. Not the 9,000
 * adverts refused on a search card, not their captured page text, not the
 * images. Whether each job accepted or refused the listing is carried across,
 * because the corpus query reads the reason.
 *
 * Every restored verdict is written with a NULL config hash, which no live
 * configuration can ever equal. That is deliberate: a restored verdict is
 * history, not a decision, so the gate never acts on it and the first genuine
 * capture decides for itself. Restoring cannot resurrect a stale answer.
 *
 * Usage, with the app stopped:
 *
 *   node tools/maintenance/recover-listings.js <snapshot.db> [--dry-run]
 */

const REASONS = {
  blacklist_pre_llm: 'blacklist',
  blacklist: 'blacklist',
  intent_filter: 'intent',
  spec_filter: 'spec',
  area_filter: 'area',
  no_price: 'no_price',
  no_coordinates: 'no_coordinates',
};

const source = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!source) {
  logger.error('Usage: node tools/maintenance/recover-listings.js <snapshot.db> [--dry-run]');
  process.exit(2);
}

await SqliteConnection.init();
await refreshConfig();
const { dbPath } = await computeDbPath();
const target = SqliteConnection.getConnection();

if (!tableExists(target, 'listing_verdicts')) {
  logger.error(`${dbPath} is not on the current schema. Start the app once so it migrates, then re-run.`);
  process.exit(1);
}

const snapshot = new Database(source, { readonly: true });
if (!tableExists(snapshot, 'listing_attributes')) {
  logger.error(`${source} has no listing_attributes; nothing to recover.`);
  process.exit(1);
}

// Only rows the model read. `listing_attributes` is the record of that: a
// listing without one never reached extraction and is a rejection, which the
// current schema keeps on the source rather than in the ledger.
const rows = snapshot
  .prepare(
    `SELECT l.id, l.created_at, l.provider, l.price, l.size, l.rooms, l.title, l.image_url,
            l.address, l.link, l.latitude, l.longitude, l.hash, l.job_id, l.hidden_reason,
            a.data AS attributes, a.schema_version, a.parsed_at,
            t.full_text, t.content_hash, t.captured_at
     FROM listings l
     JOIN listing_attributes a ON a.listing_id = l.id
     LEFT JOIN listing_texts t ON t.listing_id = l.id`,
  )
  .all();

const jobs = new Set(
  target
    .prepare('SELECT id FROM jobs')
    .all()
    .map((row) => row.id),
);
logger.info(`${rows.length} extracted listings in ${source}; ${jobs.size} jobs configured here.`);

if (dryRun) {
  const orphaned = rows.filter((row) => !jobs.has(row.job_id)).length;
  logger.info(`Dry run: would restore ${rows.length - orphaned}, skip ${orphaned} whose job no longer exists.`);
  process.exit(0);
}

const insertListing = target.prepare(
  `INSERT INTO listings (id, created_at, last_seen_at, provider, price, size, rooms, title,
                         image_url, address, link, latitude, longitude, state)
   VALUES (@id, @created_at, @created_at, @provider, @price, @size, @rooms, @title,
           @image_url, @address, @link, @latitude, @longitude, 'active')
   ON CONFLICT(id) DO NOTHING`,
);
const insertAttributes = target.prepare(
  `INSERT INTO listing_attributes (listing_id, data, schema_version, parsed_at)
   VALUES (?, ?, ?, ?) ON CONFLICT(listing_id) DO NOTHING`,
);
const insertText = target.prepare(
  `INSERT INTO listing_texts (listing_id, full_text, content_hash, captured_at)
   VALUES (?, ?, ?, ?) ON CONFLICT(listing_id) DO NOTHING`,
);
const insertVerdict = target.prepare(
  `INSERT INTO listing_verdicts (listing_id, job_id, verdict, reason, stage, config_hash,
                                 evidence_kind, evidence_hash, decided_at)
   VALUES (?, ?, ?, ?, 'extraction', NULL, 'final', NULL, ?)
   ON CONFLICT(listing_id, job_id) DO NOTHING`,
);
const insertClaim = target.prepare(
  `INSERT INTO listing_claims (claim, listing_id, source_id, kind, first_seen_at)
   VALUES (?, ?, NULL, ?, ?) ON CONFLICT(claim) DO NOTHING`,
);

let restored = 0;
let skipped = 0;
let claims = 0;
target.transaction(() => {
  for (const row of rows) {
    // A verdict needs a job. Without one the row would be a listing nobody has
    // an opinion about, invisible to the corpus and to every consumer.
    if (!jobs.has(row.job_id)) {
      skipped += 1;
      continue;
    }
    const createdAt = row.created_at ?? Date.now();
    insertListing.run({ ...row, created_at: createdAt });
    insertAttributes.run(row.id, row.attributes, row.schema_version ?? 4, row.parsed_at ?? createdAt);
    if (row.full_text) insertText.run(row.id, row.full_text, row.content_hash ?? '', row.captured_at ?? createdAt);

    const reason = row.hidden_reason ? (REASONS[row.hidden_reason] ?? 'no_detail') : null;
    insertVerdict.run(row.id, row.job_id, reason ? 'rejected' : 'accepted', reason, createdAt);

    // The claims are what stop a still-live advert being fetched and extracted a
    // second time. Only the two the snapshot can state exactly; resemblance
    // claims are the pipeline's to assert, and a wrong one is permanent.
    if (row.hash) claims += insertClaim.run(`cap:${row.hash}`, row.id, 'cap', createdAt).changes;
    if (row.link) claims += insertClaim.run(`url:${row.link}`, row.id, 'url', createdAt).changes;
    restored += 1;
  }
})();

snapshot.close();
logger.info(`Restored ${restored} listings with ${claims} claims; skipped ${skipped} whose job no longer exists.`);
logger.info('Their verdicts carry no configuration hash, so every one will be re-decided on its next sighting.');

function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}
