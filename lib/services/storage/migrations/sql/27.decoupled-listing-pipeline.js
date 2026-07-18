/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const SUPPORTED_PROVIDERS = new Set(['immoscout', 'immowelt', 'wgGesucht', 'kleinanzeigen']);

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS parsing_queue (
      id TEXT PRIMARY KEY,
      queue_kind TEXT NOT NULL CHECK (queue_kind IN ('live', 'backfill')),
      schema_version INTEGER NOT NULL DEFAULT 1,
      job_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      listing_id TEXT,
      external_id TEXT,
      source_url TEXT,
      discovered_at INTEGER NOT NULL,
      capture_json TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'captured',
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      llm_attempt_count INTEGER NOT NULL DEFAULT 0,
      geocode_attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE,
      FOREIGN KEY (listing_id) REFERENCES listings (id) ON DELETE CASCADE,
      UNIQUE (queue_kind, job_id, provider, source_hash, schema_version)
    );

    CREATE INDEX IF NOT EXISTS idx_parsing_queue_claim
      ON parsing_queue (queue_kind, status, next_attempt_at, lease_until, discovered_at);

    CREATE TABLE IF NOT EXISTS listing_extractions (
      queue_id TEXT PRIMARY KEY,
      listing_id TEXT,
      schema_version INTEGER NOT NULL,
      source_text TEXT NOT NULL DEFAULT '',
      deterministic_json TEXT,
      visual_json TEXT,
      llm_json TEXT,
      parser_mode TEXT,
      vision_model TEXT,
      text_model TEXT,
      vision_duration_ms INTEGER,
      llm_duration_ms INTEGER,
      parsed_at INTEGER,
      FOREIGN KEY (queue_id) REFERENCES parsing_queue (id) ON DELETE CASCADE,
      FOREIGN KEY (listing_id) REFERENCES listings (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_listing_extractions_listing
      ON listing_extractions (listing_id);

    CREATE TABLE IF NOT EXISTS listing_images (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      listing_id TEXT,
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
      FOREIGN KEY (queue_id) REFERENCES parsing_queue (id) ON DELETE CASCADE,
      FOREIGN KEY (listing_id) REFERENCES listings (id) ON DELETE CASCADE,
      UNIQUE (queue_id, position, original_url)
    );

    CREATE INDEX IF NOT EXISTS idx_listing_images_listing
      ON listing_images (listing_id, position);

    CREATE INDEX IF NOT EXISTS idx_listing_images_hash
      ON listing_images (content_hash);

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_ordinal INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      FOREIGN KEY (listing_id) REFERENCES listings (id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE,
      UNIQUE (listing_id, adapter_id, adapter_ordinal)
    );

    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due
      ON notification_deliveries (status, next_attempt_at, job_id, provider);

    CREATE TABLE IF NOT EXISTS processing_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id TEXT NOT NULL,
      queue_kind TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'started',
      FOREIGN KEY (queue_id) REFERENCES parsing_queue (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_processing_attempts_limits
      ON processing_attempts (queue_kind, started_at);

    CREATE TABLE IF NOT EXISTS pipeline_control (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT OR IGNORE INTO pipeline_control (name, value, updated_at)
    VALUES ('backfill_paused', '0', 0);
  `);

  addColumn(db, 'listing_attributes', 'listing_type TEXT');
  addColumn(db, 'listing_attributes', 'bedrooms REAL');
  addColumn(db, 'listing_attributes', 'bathrooms REAL');
  addColumn(db, 'listing_attributes', 'total_floors INTEGER');
  addColumn(db, 'listing_attributes', 'condition TEXT');
  addColumn(db, 'listing_attributes', 'furnished INTEGER');
  addColumn(db, 'listing_attributes', 'heating_type TEXT');
  addColumn(db, 'listing_attributes', 'energy_value_kwh REAL');
  addColumn(db, 'listing_attributes', "amenities_json TEXT NOT NULL DEFAULT '[]'");

  const jobs = db.prepare('SELECT id, provider FROM jobs').all();
  const updateJob = db.prepare('UPDATE jobs SET provider = ? WHERE id = ?');
  for (const job of jobs) {
    const providers = parseArray(job.provider).filter((provider) => SUPPORTED_PROVIDERS.has(provider?.id));
    updateJob.run(JSON.stringify(providers), job.id);
  }

  db.prepare("DELETE FROM settings WHERE name IN ('provider_details', 'blacklist_filter_on_provider_details')").run();

  const placeholders = [...SUPPORTED_PROVIDERS].map(() => '?').join(',');
  db.prepare(`UPDATE listings SET is_active = 0 WHERE provider NOT IN (${placeholders})`).run(...SUPPORTED_PROVIDERS);
}

function addColumn(db, table, definition) {
  const name = definition.split(/\s+/)[0];
  const exists = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((column) => column.name === name);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function parseArray(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
