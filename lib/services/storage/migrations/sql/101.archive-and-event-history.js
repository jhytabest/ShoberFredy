/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { canonicalUrl } from '../../../listings/claims.js';

export function up(db) {
  const now = Date.now();
  db.exec(`
    CREATE TABLE runtime_events (
      id INTEGER PRIMARY KEY, severity TEXT NOT NULL, event TEXT NOT NULL,
      message TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_runtime_events_time ON runtime_events(created_at);
    CREATE INDEX idx_runtime_events_event ON runtime_events(event, created_at);
    CREATE TABLE discovery_run_audit (
      id INTEGER PRIMARY KEY, job_id TEXT, provider TEXT NOT NULL, source_url TEXT,
      outcome TEXT NOT NULL, listing_count INTEGER, finished_at INTEGER NOT NULL
    );
    CREATE INDEX idx_discovery_run_job_time ON discovery_run_audit(job_id, provider, finished_at);
    CREATE TABLE geocode_call_audit (
      id INTEGER PRIMARY KEY, address_key TEXT NOT NULL, source_address TEXT NOT NULL,
      candidate_json TEXT NOT NULL, queue_id TEXT, listing_id TEXT, http_status INTEGER, provider_status TEXT,
      result_json TEXT, error TEXT, started_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE INDEX idx_geocode_call_address ON geocode_call_audit(address_key, started_at);
    CREATE TABLE notification_suppressions (
      listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      reason TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(listing_id, job_id)
    );
    CREATE TABLE notification_receipts (
      delivery_key TEXT NOT NULL, target_chat_id TEXT NOT NULL,
      listing_id TEXT NOT NULL, job_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      message_id INTEGER NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(delivery_key, target_chat_id)
    );
    CREATE INDEX idx_notification_receipts_listing ON notification_receipts(listing_id, job_id);
    CREATE TABLE source_identity_keys (
      identity_key TEXT NOT NULL,
      source_id TEXT NOT NULL REFERENCES listing_sources(id) ON DELETE CASCADE,
      PRIMARY KEY(identity_key, source_id)
    );
    CREATE INDEX idx_source_identity_source ON source_identity_keys(source_id);
    ALTER TABLE llm_call_audit ADD COLUMN validation_status TEXT;
    ALTER TABLE llm_call_audit ADD COLUMN validation_errors_json TEXT;
    ALTER TABLE llm_call_audit ADD COLUMN request_json TEXT;
    ALTER TABLE llm_call_audit ADD COLUMN response_json TEXT;
  `);

  for (const table of ['jobs', 'settings']) {
    const identity = table === 'jobs' ? 'id' : 'name';
    for (const [operation, row] of [
      ['INSERT', 'NEW'],
      ['UPDATE', 'NEW'],
      ['DELETE', 'OLD'],
    ]) {
      db.exec(`CREATE TRIGGER audit_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
        BEGIN
          INSERT INTO runtime_events (severity, event, message, payload_json, created_at)
          VALUES ('info', '${table}_${operation.toLowerCase()}', CAST(${row}.${identity} AS TEXT),
            json_object('table', '${table}', 'operation', '${operation}', 'id', ${row}.${identity}),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END`);
    }
  }

  // Keep previous availability evidence, but never maintain a current availability flag.
  db.prepare(
    `INSERT INTO pipeline_audit_events (listing_id, stage, action, reason, payload_json, created_at)
    SELECT id, 'migration', 'availability_archived', state_reason,
      json_object('state', state, 'stateAt', state_at, 'lastSeenAt', last_seen_at), ? FROM listings`,
  ).run(now);

  // Retiring availability must not turn historical adverts into fresh notifications.
  db.prepare(
    `INSERT OR IGNORE INTO notification_suppressions
    SELECT l.id, owned.job_id, 'historical_availability_retired', ?
    FROM listings l JOIN (
      SELECT listing_id, job_id FROM listing_verdicts
      UNION SELECT listing_id, job_id FROM listing_sources WHERE listing_id IS NOT NULL
    ) owned ON owned.listing_id = l.id JOIN jobs j ON j.id = owned.job_id
    WHERE l.state = 'gone'`,
  ).run(now);

  // Old code also used notified_at to silence failed deliveries. Without a sent
  // work record, retain suppression and remove the unsupported success claim.
  const unverified = db
    .prepare(
      `SELECT v.listing_id, v.job_id, v.notified_at FROM listing_verdicts v
    WHERE v.notified_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pipeline_work w WHERE w.kind = 'notify' AND w.status = 'done'
        AND w.outcome = 'sent' AND json_extract(w.payload_json, '$.jobId') = v.job_id
        AND COALESCE(json_extract(w.payload_json, '$.listingId'), w.key) = v.listing_id
    )`,
    )
    .all();
  for (const row of unverified) {
    db.prepare(`INSERT OR IGNORE INTO notification_suppressions VALUES (?, ?, 'legacy_delivery_unverified', ?)`).run(
      row.listing_id,
      row.job_id,
      row.notified_at,
    );
    db.prepare(
      `INSERT INTO pipeline_audit_events (listing_id, stage, action, reason, payload_json, created_at)
      VALUES (?, 'migration', 'notification_suppressed', 'legacy_delivery_unverified', ?, ?)`,
    ).run(row.listing_id, JSON.stringify({ jobId: row.job_id, previousNotifiedAt: row.notified_at }), now);
    db.prepare('UPDATE listing_verdicts SET notified_at = NULL WHERE listing_id = ? AND job_id = ?').run(
      row.listing_id,
      row.job_id,
    );
  }
  db.prepare(
    `INSERT INTO pipeline_audit_events (queue_id, stage, action, reason, created_at)
    SELECT key, 'migration', 'cancelled', 'Listing availability checks retired', ?
    FROM pipeline_work WHERE kind = 'liveness' AND status IN ('pending','processing','retry','deferred')`,
  ).run(now);
  db.prepare(
    `UPDATE pipeline_work SET status = 'cancelled', outcome = 'cancelled',
      outcome_note = 'Listing availability checks retired', lease_until = NULL, updated_at = ?
    WHERE kind = 'liveness' AND status IN ('pending','processing','retry','deferred')`,
  ).run(now);
  db.prepare(
    `INSERT INTO pipeline_audit_events (queue_id, stage, action, reason, created_at)
    SELECT w.key, 'migration', 'cancelled', 'Historical notification suppressed', ? FROM pipeline_work w
    WHERE w.kind = 'notify' AND w.status IN ('pending','processing','retry','deferred') AND EXISTS (
      SELECT 1 FROM notification_suppressions s
      WHERE s.listing_id = COALESCE(json_extract(w.payload_json, '$.listingId'), w.key)
        AND s.job_id = json_extract(w.payload_json, '$.jobId'))`,
  ).run(now);
  db.prepare(
    `UPDATE pipeline_work AS w SET status = 'cancelled', outcome = 'cancelled',
    outcome_note = 'Historical notification suppressed', lease_until = NULL, updated_at = ?
    WHERE w.kind = 'notify' AND w.status IN ('pending','processing','retry','deferred') AND EXISTS (
      SELECT 1 FROM notification_suppressions s
      WHERE s.listing_id = COALESCE(json_extract(w.payload_json, '$.listingId'), w.key)
        AND s.job_id = json_extract(w.payload_json, '$.jobId'))`,
  ).run(now);
  db.exec(`ALTER TABLE listings DROP COLUMN state;
    ALTER TABLE listings DROP COLUMN state_reason;
    ALTER TABLE listings DROP COLUMN state_at;`);

  const insertKey = db.prepare('INSERT OR IGNORE INTO source_identity_keys VALUES (?, ?)');
  const selectSources = db.prepare(
    `SELECT rowid AS cursor, id, source_url, dedupe_keys_json
    FROM listing_sources WHERE rowid > ? ORDER BY rowid LIMIT 500`,
  );
  let sourceCursor = 0;
  while (true) {
    const sources = selectSources.all(sourceCursor);
    if (sources.length === 0) break;
    for (const source of sources) {
      const keys = JSON.parse(source.dedupe_keys_json || '[]');
      const url = canonicalUrl(source.source_url);
      if (url) keys.push(`url:${url}`);
      for (const key of new Set(keys)) insertKey.run(key, source.id);
    }
    sourceCursor = sources.at(-1).cursor;
  }
  // Retire unreachable, unscoped cache rows without discarding their evidence.
  db.prepare(
    `INSERT INTO runtime_events (severity, event, message, payload_json, created_at)
    SELECT 'info', 'legacy_geocode_cache_retired', address_key,
      json_object('sourceAddress', source_address, 'status', status, 'latitude', latitude,
        'longitude', longitude, 'accuracy', accuracy, 'placeId', place_id,
        'formattedAddress', formatted_address, 'locality', locality, 'error', error,
        'attempts', attempts, 'createdAt', created_at, 'updatedAt', updated_at), ?
    FROM homeserver_geocode_cache WHERE instr(address_key, '::') = 0`,
  ).run(now);
  db.exec("DELETE FROM homeserver_geocode_cache WHERE instr(address_key, '::') = 0");
  db.prepare(
    `INSERT INTO runtime_events (severity, event, message, payload_json, created_at)
    SELECT 'info', 'monitoring_snapshot_retired', name, value, ? FROM pipeline_control
    WHERE name = 'data_integrity_verdict' OR name LIKE 'discovery:%'`,
  ).run(now);
  db.exec("DELETE FROM pipeline_control WHERE name = 'data_integrity_verdict' OR name LIKE 'discovery:%'");
}
