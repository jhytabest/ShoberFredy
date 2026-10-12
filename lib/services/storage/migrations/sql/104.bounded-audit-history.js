/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export function up(db) {
  // Previous expiry was 30 days from last use; retain that last-use date.
  db.exec(`
    UPDATE audit_payloads SET permanent = 0, expires_at = expires_at - 1382400000;
    DELETE FROM pipeline_control WHERE name LIKE 'llm_model_pause:%';
    CREATE INDEX idx_work_fair_claim ON pipeline_work(kind, updated_at, next_attempt_at);
    CREATE INDEX idx_llm_request_payload ON llm_call_audit(request_payload_sha256);
    CREATE INDEX idx_llm_response_payload ON llm_call_audit(response_payload_sha256);
    CREATE INDEX idx_geocode_result_payload ON geocode_call_audit(result_payload_sha256);
    CREATE INDEX idx_runtime_payload ON runtime_events(payload_sha256);
    CREATE INDEX idx_observation_payload ON listing_source_observations(payload_sha256);
    CREATE INDEX idx_discovery_retention ON discovery_run_audit(finished_at);
  `);
}
