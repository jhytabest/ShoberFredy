/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Final LLM-only extraction contract.
 *
 * - preserve every unfinished live capture under schema v3;
 * - enqueue every stored listing for a safe, text-only LLM refresh;
 * - remove all legacy deterministic extraction data and queue history;
 * - add durable, full request/response auditing for every LLM HTTP call;
 * - version persisted attributes so consumers can reject pre-v3 values.
 */
export function up(db) {
  const now = Date.now();

  addColumn(db, 'listing_attributes', 'schema_version INTEGER NOT NULL DEFAULT 0');

  db.exec(`
    CREATE TABLE live_queue_v3_map (
      old_id TEXT PRIMARY KEY,
      new_id TEXT NOT NULL UNIQUE
    );

    INSERT INTO live_queue_v3_map (old_id, new_id)
    SELECT id, lower(hex(randomblob(16)))
    FROM parsing_queue
    WHERE queue_kind = 'live'
      AND status NOT IN ('completed', 'duplicate', 'cancelled');

    INSERT INTO parsing_queue (
      id, queue_kind, schema_version, job_id, provider, source_hash, listing_id,
      external_id, source_url, discovered_at, capture_json, stage, status,
      attempt_count, llm_attempt_count, geocode_attempt_count, lease_until,
      next_attempt_at, last_error, created_at, updated_at, completed_at
    )
    SELECT m.new_id, 'live', 3, q.job_id, q.provider, q.source_hash, q.listing_id,
      q.external_id, q.source_url, q.discovered_at, q.capture_json, 'captured', 'pending',
      0, 0, 0, NULL, 0, NULL, ${now}, ${now}, NULL
    FROM live_queue_v3_map m
    JOIN parsing_queue q ON q.id = m.old_id;

    INSERT INTO listing_images (
      id, queue_id, listing_id, position, kind, original_url, storage_path,
      content_hash, mime_type, byte_size, width, height, download_status, error
    )
    SELECT lower(hex(randomblob(16))), m.new_id, i.listing_id, i.position, i.kind,
      i.original_url, i.storage_path, i.content_hash, i.mime_type, i.byte_size,
      i.width, i.height, i.download_status, i.error
    FROM listing_images i
    JOIN live_queue_v3_map m ON m.old_id = i.queue_id;

    INSERT INTO parsing_queue (
      id, queue_kind, schema_version, job_id, provider, source_hash, listing_id,
      external_id, source_url, discovered_at, capture_json, stage, status,
      attempt_count, llm_attempt_count, geocode_attempt_count, lease_until,
      next_attempt_at, last_error, created_at, updated_at, completed_at
    )
    SELECT lower(hex(randomblob(16))), 'backfill', 3, l.job_id, l.provider,
      COALESCE(l.hash, l.id), l.id, COALESCE(l.hash, l.id), l.link,
      COALESCE(l.created_at, ${now}),
      COALESCE(
        (
          SELECT q.capture_json
          FROM parsing_queue q
          WHERE q.job_id = l.job_id
            AND q.provider = l.provider
            AND q.source_hash = l.hash
            AND q.capture_json IS NOT NULL
          ORDER BY q.schema_version DESC, q.updated_at DESC
          LIMIT 1
        ),
        json_object(
          'provider', l.provider,
          'externalId', COALESCE(l.hash, l.id),
          'sourceUrl', l.link,
          'discoveredAt', COALESCE(l.created_at, ${now}),
          'discoveryData', json_object(
            'id', COALESCE(l.hash, l.id),
            'link', l.link,
            'title', l.title,
            'price', l.price,
            'size', l.size,
            'rooms', l.rooms,
            'address', l.address,
            'image', l.image_url,
            'description', l.description
          ),
          'fullText', COALESCE(l.description, ''),
          'embeddedData', json_array(),
          'images', json_array(),
          'backfillSchemaVersion', 3
        )
      ),
      'captured', 'pending', 0, 0, 0, NULL, 0, NULL, ${now}, ${now}, NULL
    FROM listings l;

    DELETE FROM parsing_queue WHERE schema_version < 3;
    DROP TABLE live_queue_v3_map;

    DROP TABLE listing_extractions;
    CREATE TABLE listing_extractions (
      queue_id TEXT PRIMARY KEY,
      listing_id TEXT,
      schema_version INTEGER NOT NULL,
      source_text TEXT NOT NULL DEFAULT '',
      visual_json TEXT,
      llm_json TEXT,
      vision_model TEXT,
      text_model TEXT,
      vision_duration_ms INTEGER,
      llm_duration_ms INTEGER,
      parsed_at INTEGER,
      FOREIGN KEY (queue_id) REFERENCES parsing_queue (id) ON DELETE CASCADE,
      FOREIGN KEY (listing_id) REFERENCES listings (id) ON DELETE CASCADE
    );

    CREATE INDEX idx_listing_extractions_listing
      ON listing_extractions (listing_id);

    CREATE TABLE llm_call_audit (
      id TEXT PRIMARY KEY,
      queue_id TEXT,
      listing_id TEXT,
      queue_kind TEXT NOT NULL CHECK (queue_kind IN ('live', 'backfill')),
      operation TEXT NOT NULL,
      model TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      request_json TEXT NOT NULL,
      response_body TEXT,
      response_headers_json TEXT,
      usage_json TEXT,
      http_status INTEGER,
      outcome TEXT NOT NULL DEFAULT 'started',
      error TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX idx_llm_call_audit_queue
      ON llm_call_audit (queue_id, started_at);
    CREATE INDEX idx_llm_call_audit_listing
      ON llm_call_audit (listing_id, started_at);
    CREATE INDEX idx_llm_call_audit_outcome
      ON llm_call_audit (outcome, started_at);

    DELETE FROM listing_attributes;
    DELETE FROM homeserver_models;
    DELETE FROM homeserver_listing_model_scores;
    DELETE FROM homeserver_listing_market_model;
    DELETE FROM homeserver_market_surface_cells;
    DELETE FROM homeserver_model_runs;
    DELETE FROM homeserver_listing_scores;

    INSERT INTO pipeline_control (name, value, updated_at)
    VALUES ('parser_backfill_credit', '0', ${now})
    ON CONFLICT(name) DO UPDATE SET value = '0', updated_at = excluded.updated_at;

    UPDATE notification_deliveries
    SET status = 'pending', next_attempt_at = 0
    WHERE status = 'failed';

    DELETE FROM processing_attempts;
  `);
}

function addColumn(db, table, definition) {
  const name = definition.split(/\s+/)[0];
  const exists = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((column) => column.name === name);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}
