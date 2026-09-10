/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export function up(db) {
  db.exec(`
    CREATE TABLE geocode_progress (
      address_key TEXT PRIMARY KEY, signature TEXT NOT NULL, candidate_index INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE audit_payloads (
      sha256 TEXT PRIMARY KEY,
      body_json TEXT CHECK(body_json IS NULL OR json_valid(body_json)),
      byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      trimmed_at INTEGER,
      permanent INTEGER NOT NULL DEFAULT 0 CHECK(permanent IN (0, 1))
    ) WITHOUT ROWID;
    CREATE INDEX idx_audit_payload_expiry ON audit_payloads(expires_at) WHERE body_json IS NOT NULL AND permanent = 0;
    CREATE TABLE audit_payload_edges (
      parent_sha256 TEXT NOT NULL REFERENCES audit_payloads(sha256),
      position INTEGER NOT NULL,
      child_sha256 TEXT NOT NULL REFERENCES audit_payloads(sha256),
      PRIMARY KEY(parent_sha256, position)
    ) WITHOUT ROWID;
    CREATE INDEX idx_payload_child ON audit_payload_edges(child_sha256);
    ALTER TABLE runtime_events ADD COLUMN payload_sha256 TEXT REFERENCES audit_payloads(sha256);
    ALTER TABLE listing_source_observations ADD COLUMN payload_sha256 TEXT REFERENCES audit_payloads(sha256);
    ALTER TABLE llm_call_audit ADD COLUMN request_payload_sha256 TEXT REFERENCES audit_payloads(sha256);
    ALTER TABLE llm_call_audit ADD COLUMN response_payload_sha256 TEXT REFERENCES audit_payloads(sha256);
    ALTER TABLE llm_call_audit ADD COLUMN attempt_group TEXT;
    ALTER TABLE llm_call_audit ADD COLUMN model_position INTEGER;
    ALTER TABLE llm_call_audit ADD COLUMN provider TEXT;
    ALTER TABLE llm_call_audit ADD COLUMN budget_refunded INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX idx_llm_attempt_group ON llm_call_audit(attempt_group, model_position);
    CREATE INDEX idx_llm_outcome_time ON llm_call_audit(outcome, started_at);
    ALTER TABLE geocode_call_audit ADD COLUMN result_payload_sha256 TEXT REFERENCES audit_payloads(sha256);
    CREATE INDEX idx_geocode_call_time ON geocode_call_audit(started_at);
    ALTER TABLE listing_images ADD COLUMN retained_until INTEGER;
    ALTER TABLE listing_images ADD COLUMN removed_at INTEGER;
    CREATE INDEX idx_media_retention ON listing_images(retained_until) WHERE download_status = 'stored';
    CREATE INDEX idx_work_terminal_retention ON pipeline_work(updated_at)
      WHERE status IN ('done', 'dead', 'cancelled');
    CREATE INDEX idx_legacy_llm_bodies ON llm_call_audit(started_at)
      WHERE request_json IS NOT NULL OR response_json IS NOT NULL;
    CREATE INDEX idx_legacy_runtime_bodies ON runtime_events(created_at) WHERE payload_json IS NOT NULL;
    CREATE VIEW runtime_event_details AS
      SELECT e.id, e.severity, e.event, e.message, e.created_at, e.payload_sha256,
             COALESCE(e.payload_json, p.body_json) AS payload_json, p.trimmed_at
      FROM runtime_events e LEFT JOIN audit_payloads p ON p.sha256 = e.payload_sha256;
    CREATE VIEW geocode_attempt_history AS
      SELECT a.id, a.queue_id, a.listing_id, a.address_key, a.source_address, a.candidate_json,
             a.started_at, a.completed_at, a.http_status, a.provider_status, a.error,
             a.result_json AS summary_json, p.body_json AS result_json, p.trimmed_at
      FROM geocode_call_audit a LEFT JOIN audit_payloads p ON p.sha256 = a.result_payload_sha256;
    CREATE VIEW llm_attempt_history AS
      SELECT id, queue_id, attempt_group, model_position, model, provider, operation,
             started_at, completed_at, completed_at - started_at AS duration_ms,
             outcome, http_status, validation_status, validation_errors_json, error,
             budget_refunded, usage_json, request_bytes, response_bytes,
             request_sha256, response_sha256, request_payload_sha256, response_payload_sha256
      FROM llm_call_audit;
  `);
}
