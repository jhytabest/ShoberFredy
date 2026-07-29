/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { tableExists } from '../../../../shared/sqlite.js';
import { toJson } from '../../../../shared/json.js';

/**
 * Collapse the four durable pipeline queues into one `pipeline_work` table.
 *
 * `detail_fetch_queue`, `parsing_queue`, `rating_queue` and
 * `notification_deliveries` all carried the same four scheduling columns —
 * status, attempt_count, lease_until, next_attempt_at — and were drained by
 * four workers that differed only in the payload and the function applied to
 * it. One table with a `kind` discriminator means one claim, one lease and one
 * backoff expression instead of four copies that had already drifted: the
 * notification outbox retried on a 15-minute base with a 24-hour ceiling, the
 * rating queue capped at six hours, and the other two at one.
 *
 * PRIMARY KEY (kind, key) is the load-bearing part. Every kind now gets the
 * idempotent enqueue that only `notification_deliveries` had, through a bespoke
 * UNIQUE constraint, so re-discovering the same advert can no longer create a
 * second work item for it.
 *
 * The natural key per kind:
 *   detail  `jobId|provider|sourceKey`  the source identity, which is exactly
 *           the old UNIQUE(job_id, provider, source_key): one outstanding
 *           capture per advert per job, whatever the discovery card says this
 *           time round.
 *   parse   `jobId|sourceHash`          the capture version. The hash covers
 *           provider, source key, URL, page text and embedded data, so
 *           re-enqueueing unchanged evidence is a no-op, while genuinely new
 *           evidence becomes its own unit of work with its own images and
 *           extraction instead of overwriting the previous one. Job-scoped
 *           because two jobs that find the same advert still finalize into
 *           their own listings, and the hash on its own is job-independent —
 *           44 hashes in the live database are shared across jobs and would
 *           have been fused into one work item.
 *   rate    listing id                  already the old primary key.
 *   notify  listing id                  the old key was (listing_id,
 *           adapter_id, adapter_ordinal). There is one adapter, so the ordinal
 *           is always 0 and the id always 'telegram': the compound key
 *           collapses to the listing. This is where the notification-adapter
 *           abstraction dies in the schema.
 *
 * Idempotency: the whole current-schema file re-runs whenever its checksum
 * changes, and its `createCoreTables()` re-creates the four absorbed tables
 * empty every time it does. Every phase below is therefore guarded on the
 * schema it actually needs, and absorbing zero rows out of a freshly
 * re-created empty table is a no-op.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function migrateWorkQueue(db) {
  // The self-referencing listing_sources copy and the key remapping below both
  // break referential integrity mid-transaction and restore it before commit.
  db.pragma('defer_foreign_keys = ON');

  createWorkTable(db);
  dropRebuildLeftovers(db);
  detachFromRetiredQueues(db, absorbLegacyQueues(db));

  // Order matters: detail_fetch_queue.capture_queue_id points at parsing_queue,
  // so the referencing table goes first.
  db.exec(`
    DROP TABLE IF EXISTS notification_deliveries;
    DROP TABLE IF EXISTS rating_queue;
    DROP TABLE IF EXISTS processing_attempts;
    DROP TABLE IF EXISTS detail_fetch_queue;
    DROP TABLE IF EXISTS parsing_queue;
  `);

  createIndexes(db);
}

function createWorkTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_work (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
    );
  `);
}

/**
 * Every table this step rebuilds keeps its indexes, so they are recreated here
 * rather than relying on the schema file that calls us.
 *
 * They are created last, after the rebuild scaffolding is gone: ALTER TABLE
 * RENAME leaves a table's indexes attached to it under their original names, so
 * creating them any earlier would find the name taken by an index hanging off
 * the copy that is about to be dropped, and IF NOT EXISTS would silently leave
 * the new table unindexed.
 */
function createIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pipeline_work_claim
      ON pipeline_work(kind, status, next_attempt_at, lease_until);
    CREATE INDEX IF NOT EXISTS idx_listing_images_listing ON listing_images(listing_id, position);
    CREATE INDEX IF NOT EXISTS idx_listing_images_hash ON listing_images(content_hash);
    CREATE INDEX IF NOT EXISTS idx_listing_extractions_listing ON listing_extractions(listing_id);
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_queue ON llm_call_audit(queue_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_listing ON llm_call_audit(listing_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_outcome ON llm_call_audit(outcome, started_at);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_url ON listing_sources(job_id, source_url);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_detail ON listing_sources(detail_queue_id);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_parsing ON listing_sources(parsing_queue_id);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_listing ON listing_sources(listing_id);
    CREATE INDEX IF NOT EXISTS idx_listing_source_observations_source
      ON listing_source_observations(source_id, stage, observed_at);
    CREATE INDEX IF NOT EXISTS idx_pipeline_audit_source ON pipeline_audit_events(source_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pipeline_audit_listing ON pipeline_audit_events(listing_id, created_at);
  `);
}

/** Tables rebuilt to drop a foreign key into a retired queue, or to follow one that is. */
const REBUILT_TABLES = [
  'listing_sources',
  'listing_source_observations',
  'pipeline_audit_events',
  'listing_images',
  'listing_extractions',
  'llm_call_audit',
];

function dropRebuildLeftovers(db) {
  for (const table of REBUILT_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}__wq`);
}

/**
 * Copy every row of the four queues into `pipeline_work`, returning the old
 * id → new key mapping that the rows pointing at those ids need.
 *
 * Bulk payloads — a discovery card, a page capture — are carried over only for
 * work that is still claimable, which is what the pipeline already did once an
 * item reached a terminal state: the evidence itself lives in
 * listing_source_observations and listing_texts, and a second copy per finished
 * item is what made the queues the largest tables in the database. Identity,
 * scheduling and the last error are kept for every row, because
 * `enqueueDiscovery` reads the terminal verdict of an old row to avoid
 * re-deciding a card that the search results keep showing.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{kind: string, oldId: string, key: string}[]}
 */
function absorbLegacyQueues(db) {
  const insert = db.prepare(
    `INSERT INTO pipeline_work (
       kind, key, payload_json, status, attempt_count, lease_until,
       next_attempt_at, last_error, created_at, updated_at
     ) VALUES (
       @kind, @key, @payload, @status, @attemptCount, @leaseUntil,
       @nextAttemptAt, @lastError, @createdAt, @updatedAt
     )
     ON CONFLICT(kind, key) DO NOTHING`,
  );
  const mapping = [];
  const parseKeys = new Map();

  const absorb = (kind, oldId, key, payload, schedule) => {
    insert.run({
      kind,
      key,
      payload: toJson(payload) ?? '{}',
      status: schedule.status,
      attemptCount: schedule.attempt_count ?? 0,
      leaseUntil: schedule.lease_until ?? null,
      nextAttemptAt: schedule.next_attempt_at ?? 0,
      lastError: schedule.last_error ?? null,
      createdAt: schedule.created_at ?? 0,
      updatedAt: schedule.updated_at ?? schedule.created_at ?? 0,
    });
    mapping.push({ kind, oldId, key });
  };

  // Parse first: a detail row records the parse item its capture produced.
  if (tableExists(db, 'parsing_queue')) {
    // Metadata for every row, the multi-megabyte capture columns only for the
    // rows that keep them. Selecting `*` here pulled the whole evidence corpus
    // into memory to throw almost all of it away again.
    const capture = db.prepare('SELECT capture_json FROM parsing_queue WHERE id = ?').pluck();
    const rows = db
      .prepare(
        `SELECT id, job_id, provider, source_key, source_hash, listing_id, external_id,
                source_url, discovered_at, stage, status, attempt_count, llm_attempt_count,
                geocode_attempt_count, lease_until, next_attempt_at, last_error,
                created_at, updated_at, completed_at
           FROM parsing_queue`,
      )
      .all();
    for (const row of rows) {
      const key = `${row.job_id}|${row.source_hash}`;
      parseKeys.set(row.id, key);
      absorb(
        'parse',
        row.id,
        key,
        {
          jobId: row.job_id,
          provider: row.provider,
          sourceKey: row.source_key,
          sourceHash: row.source_hash,
          listingId: row.listing_id ?? undefined,
          externalId: row.external_id ?? undefined,
          sourceUrl: row.source_url ?? undefined,
          discoveredAt: row.discovered_at,
          stage: row.stage,
          llmAttempts: row.llm_attempt_count ?? 0,
          geocodeAttempts: row.geocode_attempt_count ?? 0,
          completedAt: row.completed_at ?? undefined,
          capture: claimable(row.status) ? fromColumn(capture.get(row.id)) : undefined,
        },
        row,
      );
    }
  }

  if (tableExists(db, 'detail_fetch_queue')) {
    const evidence = db.prepare('SELECT discovery_json, capture_json FROM detail_fetch_queue WHERE id = ?');
    const rows = db
      .prepare(
        `SELECT id, job_id, provider, source_key, external_id, source_url, discovery_hash,
                status, attempt_count, lease_until, next_attempt_at, last_error,
                capture_queue_id, created_at, updated_at, completed_at
           FROM detail_fetch_queue`,
      )
      .all();
    for (const row of rows) {
      const held = claimable(row.status) ? evidence.get(row.id) : {};
      absorb(
        'detail',
        row.id,
        `${row.job_id}|${row.provider}|${row.source_key}`,
        {
          jobId: row.job_id,
          provider: row.provider,
          sourceKey: row.source_key,
          externalId: row.external_id ?? undefined,
          sourceUrl: row.source_url,
          discoveryHash: row.discovery_hash,
          captureKey: parseKeys.get(row.capture_queue_id) ?? row.capture_queue_id ?? undefined,
          completedAt: row.completed_at ?? undefined,
          discovery: fromColumn(held.discovery_json),
          capture: fromColumn(held.capture_json),
        },
        row,
      );
    }
  }

  if (tableExists(db, 'rating_queue')) {
    for (const row of db.prepare('SELECT * FROM rating_queue').all()) {
      absorb(
        'rate',
        row.listing_id,
        row.listing_id,
        {
          listingId: row.listing_id,
          jobId: row.job_id,
          provider: row.provider,
          notify: row.notify === 1,
          completedAt: row.completed_at ?? undefined,
        },
        row,
      );
    }
  }

  if (tableExists(db, 'notification_deliveries')) {
    // Ordering by ordinal makes the configured-first adapter win; any further
    // row for the same listing is dropped by the conflict clause. That is the
    // one deliberate de-duplication in this migration, and it removes nothing
    // on a single-adapter database, where the ordinal is always 0.
    const rows = db.prepare('SELECT * FROM notification_deliveries ORDER BY adapter_ordinal, created_at').all();
    for (const row of rows) {
      absorb(
        'notify',
        row.id,
        row.listing_id,
        {
          listingId: row.listing_id,
          jobId: row.job_id,
          provider: row.provider,
          completedAt: row.sent_at ?? undefined,
        },
        { ...row, attempt_count: row.attempts, updated_at: row.sent_at ?? row.created_at },
      );
    }
  }

  return mapping;
}

function claimable(status) {
  return status === 'pending' || status === 'processing' || status === 'retry';
}

function fromColumn(value) {
  if (value == null || value === '') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? undefined : parsed;
  } catch {
    return undefined;
  }
}

/**
 * Rewrite every foreign key that pointed into the absorbed queues.
 *
 * This phase cannot be skipped. With `foreign_keys = ON` a DROP TABLE runs an
 * implicit DELETE first, so dropping `parsing_queue` while listing_images,
 * listing_extractions and processing_attempts still declared ON DELETE CASCADE
 * against it would have taken 32,636 image rows and every extraction with it,
 * and the ON DELETE SET NULL references from llm_call_audit and listing_sources
 * would have erased the link between an audited call and the work that made it.
 *
 * Removing a constraint in SQLite means rebuilding the table, and a rebuild has
 * to rename the original out of the way first — which rewrites the REFERENCES
 * clauses of everything pointing at it. That is why listing_source_observations
 * and pipeline_audit_events are rebuilt as well: they hold no queue reference
 * at all, they only have to follow listing_sources to its new identity, or the
 * final DROP of the old copy would cascade 21,009 observations away and null
 * out 128,264 audit events. The copies are dropped in an order where nothing
 * still references what is being removed.
 *
 * The queue columns survive as plain TEXT holding the new work keys:
 * `listing_sources.detail_queue_id` and `.parsing_queue_id` keep their names
 * and their meaning, they simply no longer name a row in a table that exists.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{kind: string, oldId: string, key: string}[]} mapping
 */
function detachFromRetiredQueues(db, mapping) {
  if (!referencesRetiredQueue(db)) return;

  db.exec('DROP TABLE IF EXISTS pipeline_work_map__wq');
  db.exec('CREATE TABLE pipeline_work_map__wq(kind TEXT NOT NULL, old_id TEXT NOT NULL, new_key TEXT NOT NULL)');
  const insertMapping = db.prepare('INSERT INTO pipeline_work_map__wq(kind, old_id, new_key) VALUES (?, ?, ?)');
  for (const entry of mapping) insertMapping.run(entry.kind, entry.oldId, entry.key);
  db.exec('CREATE INDEX idx_pipeline_work_map__wq ON pipeline_work_map__wq(kind, old_id)');

  // Every rename happens before any table is re-created, so the mutual
  // references inside the renamed set stay consistent with each other.
  for (const table of REBUILT_TABLES) db.exec(`ALTER TABLE ${table} RENAME TO ${table}__wq`);

  db.exec(`
    CREATE TABLE listing_sources (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_url TEXT NOT NULL,
      detail_queue_id TEXT,
      parsing_queue_id TEXT,
      listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
      representative_source_id TEXT REFERENCES listing_sources(id) ON DELETE SET NULL,
      dedupe_stage TEXT,
      dedupe_keys_json TEXT NOT NULL DEFAULT '[]',
      hidden_reason TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      UNIQUE(job_id, provider, source_key)
    );

    CREATE TABLE listing_source_observations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES listing_sources(id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK(stage IN ('discovery','detail')),
      content_hash TEXT NOT NULL,
      content_bytes INTEGER NOT NULL DEFAULT 0,
      observed_at INTEGER NOT NULL,
      UNIQUE(source_id, stage, content_hash)
    );

    CREATE TABLE pipeline_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT REFERENCES listing_sources(id) ON DELETE SET NULL,
      listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
      queue_id TEXT,
      stage TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE listing_images (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      listing_id TEXT REFERENCES listings(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'photo',
      original_url TEXT,
      storage_path TEXT,
      content_hash TEXT,
      mime_type TEXT,
      byte_size INTEGER,
      width INTEGER,
      height INTEGER,
      download_status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      UNIQUE(queue_id, position)
    );

    CREATE TABLE listing_extractions (
      queue_id TEXT PRIMARY KEY,
      listing_id TEXT REFERENCES listings(id) ON DELETE CASCADE,
      visual_json TEXT,
      llm_json TEXT,
      vision_model TEXT,
      text_model TEXT,
      vision_duration_ms INTEGER,
      llm_duration_ms INTEGER,
      parsed_at INTEGER
    );

    CREATE TABLE llm_call_audit (
      id TEXT PRIMARY KEY,
      queue_id TEXT,
      listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
      operation TEXT NOT NULL,
      model TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      request_bytes INTEGER NOT NULL,
      response_sha256 TEXT,
      response_bytes INTEGER,
      response_headers_json TEXT,
      usage_json TEXT,
      http_status INTEGER,
      outcome TEXT NOT NULL DEFAULT 'started',
      error TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    INSERT INTO listing_sources (
      id, job_id, provider, source_key, source_url, detail_queue_id,
      parsing_queue_id, listing_id, representative_source_id, dedupe_stage,
      dedupe_keys_json, hidden_reason, first_seen_at, last_seen_at
    )
    SELECT s.id, s.job_id, s.provider, s.source_key, s.source_url,
           COALESCE(d.new_key, s.detail_queue_id),
           COALESCE(p.new_key, s.parsing_queue_id),
           s.listing_id, s.representative_source_id, s.dedupe_stage,
           s.dedupe_keys_json, s.hidden_reason, s.first_seen_at, s.last_seen_at
    FROM listing_sources__wq s
    LEFT JOIN pipeline_work_map__wq d ON d.kind = 'detail' AND d.old_id = s.detail_queue_id
    LEFT JOIN pipeline_work_map__wq p ON p.kind = 'parse' AND p.old_id = s.parsing_queue_id;

    INSERT INTO listing_source_observations (id, source_id, stage, content_hash, content_bytes, observed_at)
    SELECT id, source_id, stage, content_hash, content_bytes, observed_at
    FROM listing_source_observations__wq;

    INSERT INTO pipeline_audit_events (
      id, source_id, listing_id, queue_id, stage, action, reason, payload_json, created_at
    )
    SELECT a.id, a.source_id, a.listing_id, COALESCE(m.new_key, a.queue_id),
           a.stage, a.action, a.reason, a.payload_json, a.created_at
    FROM pipeline_audit_events__wq a
    LEFT JOIN pipeline_work_map__wq m ON m.old_id = a.queue_id AND m.kind IN ('detail', 'parse');

    INSERT INTO listing_images (
      id, queue_id, listing_id, position, kind, original_url, storage_path,
      content_hash, mime_type, byte_size, width, height, download_status, error
    )
    SELECT i.id, COALESCE(m.new_key, i.queue_id), i.listing_id, i.position, i.kind,
           i.original_url, i.storage_path, i.content_hash, i.mime_type, i.byte_size,
           i.width, i.height, i.download_status, i.error
    FROM listing_images__wq i
    LEFT JOIN pipeline_work_map__wq m ON m.kind = 'parse' AND m.old_id = i.queue_id;

    INSERT INTO listing_extractions (
      queue_id, listing_id, visual_json, llm_json, vision_model, text_model,
      vision_duration_ms, llm_duration_ms, parsed_at
    )
    SELECT COALESCE(m.new_key, e.queue_id), e.listing_id, e.visual_json, e.llm_json,
           e.vision_model, e.text_model, e.vision_duration_ms, e.llm_duration_ms, e.parsed_at
    FROM listing_extractions__wq e
    LEFT JOIN pipeline_work_map__wq m ON m.kind = 'parse' AND m.old_id = e.queue_id;

    INSERT INTO llm_call_audit (
      id, queue_id, listing_id, operation, model, tool_name, request_sha256,
      request_bytes, response_sha256, response_bytes, response_headers_json,
      usage_json, http_status, outcome, error, started_at, completed_at
    )
    SELECT a.id, COALESCE(m.new_key, a.queue_id), a.listing_id, a.operation, a.model,
           a.tool_name, a.request_sha256, a.request_bytes, a.response_sha256,
           a.response_bytes, a.response_headers_json, a.usage_json, a.http_status,
           a.outcome, a.error, a.started_at, a.completed_at
    FROM llm_call_audit__wq a
    LEFT JOIN pipeline_work_map__wq m ON m.kind = 'parse' AND m.old_id = a.queue_id;

    DROP TABLE listing_source_observations__wq;
    DROP TABLE pipeline_audit_events__wq;
    DROP TABLE listing_sources__wq;
    DROP TABLE listing_images__wq;
    DROP TABLE listing_extractions__wq;
    DROP TABLE llm_call_audit__wq;
    DROP TABLE pipeline_work_map__wq;
  `);
}

/**
 * Whether any table still declares a foreign key into one of the retired
 * queues. This is the "already converted" test for the detach phase, and it has
 * to be a property of the schema rather than of the data: the schema file that
 * calls us re-creates the four queue tables empty on every re-run, so their
 * mere existence proves nothing about what has already been rewritten.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean}
 */
function referencesRetiredQueue(db) {
  const retired = new Set(['parsing_queue', 'detail_fetch_queue', 'rating_queue', 'notification_deliveries']);
  const targets = db.prepare('SELECT "table" AS target FROM pragma_foreign_key_list(?)');
  return REBUILT_TABLES.some(
    (table) => tableExists(db, table) && targets.all(table).some((row) => retired.has(row.target)),
  );
}
