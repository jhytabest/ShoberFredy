/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { classifyOpenRouterError } from '../../../pipeline/openRouterErrors.js';

export function up(db) {
  const pause = db.prepare("SELECT value, updated_at FROM pipeline_control WHERE name = 'llm_service_pause'").get();
  if (!pause) return;
  const state = JSON.parse(pause.value);
  if (state.until !== 8640000000000000 || !state.reason?.startsWith('OpenRouter configuration failure (')) return;

  // Preserve real configuration failures. Only reconsider the call that could
  // have created this historical indefinite pause, using its retained evidence.
  const call = db
    .prepare(
      `SELECT a.http_status, a.error, COALESCE(a.response_json, p.body_json) AS response_json
       FROM llm_call_audit a LEFT JOIN audit_payloads p ON p.sha256 = a.response_payload_sha256
       WHERE a.started_at <= ? ORDER BY a.started_at DESC LIMIT 1`,
    )
    .get(pause.updated_at);
  if (!call) return;
  let payload = null;
  try {
    payload = JSON.parse(call.response_json);
  } catch {
    // The compact audit error can still identify the outage after payload expiry.
  }
  const classification = classifyOpenRouterError(payload?.error ?? { message: call.error }, call.http_status);
  if (classification.outcome !== 'upstream_capacity' || classification.permanent) return;
  db.prepare("DELETE FROM pipeline_control WHERE name = 'llm_service_pause'").run();
}
