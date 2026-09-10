/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { env } from '../../shared/env.js';

const BATCH_SIZE = 500;

export function retainAuditPayloads(db, now = Date.now()) {
  const cutoff = now - env('FREDY_AUDIT_PAYLOAD_DAYS') * 86400000;
  const result = { payloadsTrimmed: 0, legacyCallsTrimmed: 0, terminalCapturesTrimmed: 0, legacyInputsTrimmed: 0 };
  const deadline = Date.now() + 5000;
  let changed;
  do {
    changed = 0;
    const before = Object.values(result).reduce((sum, count) => sum + count, 0);
    db.transaction(() => {
      result.legacyCallsTrimmed += db
        .prepare(
          `UPDATE llm_call_audit SET request_json = NULL, response_json = NULL
      WHERE id IN (SELECT id FROM llm_call_audit WHERE started_at < ?
        AND (request_json IS NOT NULL OR response_json IS NOT NULL) LIMIT ?)`,
        )
        .run(cutoff, BATCH_SIZE).changes;
      result.payloadsTrimmed += db
        .prepare(
          `UPDATE audit_payloads SET body_json = NULL, trimmed_at = ?
      WHERE sha256 IN (SELECT sha256 FROM audit_payloads WHERE expires_at <= ? AND body_json IS NOT NULL AND permanent = 0 LIMIT ?)`,
        )
        .run(now, now, BATCH_SIZE).changes;

      const rows = db
        .prepare(
          `SELECT kind, key, payload_json FROM pipeline_work
      WHERE status IN ('done', 'dead', 'cancelled') AND updated_at < ?
        AND (json_type(payload_json, '$.capture') IS NOT NULL OR json_type(payload_json, '$.discovery') IS NOT NULL)
      ORDER BY updated_at LIMIT ?`,
        )
        .all(cutoff, BATCH_SIZE);
      for (const row of rows) {
        db.prepare(
          `UPDATE pipeline_work SET payload_json = json_remove(payload_json, '$.capture', '$.discovery')
        WHERE kind = ? AND key = ?`,
        ).run(row.kind, row.key);
        db.prepare(
          `INSERT INTO pipeline_audit_events(queue_id, stage, action, reason, payload_json, created_at)
        VALUES (?, 'maintenance', 'payload_expired', 'Terminal capture retention elapsed', ?, ?)`,
        ).run(row.key, JSON.stringify({ kind: row.kind, bytes: Buffer.byteLength(row.payload_json) }), now);
      }
      result.terminalCapturesTrimmed += rows.length;
      // Legacy prompt copies are not needed to resume an already completed extraction.
      result.legacyInputsTrimmed += db
        .prepare(
          `UPDATE listing_extractions SET llm_json = json_remove(llm_json, '$.provenance.input')
      WHERE queue_id IN (SELECT queue_id FROM listing_extractions WHERE parsed_at < ?
        AND json_valid(llm_json) AND json_type(llm_json, '$.provenance.input') IS NOT NULL LIMIT ?)`,
        )
        .run(cutoff, BATCH_SIZE).changes;
      // Existing geocoder rows retain their compact request/status; only old result bodies expire.
      changed += db
        .prepare(
          `UPDATE geocode_call_audit SET result_json = NULL
      WHERE id IN (SELECT id FROM geocode_call_audit WHERE completed_at < ?
        AND result_payload_sha256 IS NULL AND result_json IS NOT NULL AND length(result_json) > 2048 LIMIT ?)`,
        )
        .run(cutoff, BATCH_SIZE).changes;
      changed += db
        .prepare(
          `UPDATE runtime_events SET payload_json = NULL
      WHERE id IN (SELECT id FROM runtime_events WHERE created_at < ? AND payload_json IS NOT NULL AND length(payload_json) > 2048 LIMIT ?)`,
        )
        .run(cutoff, BATCH_SIZE).changes;
    })();
    changed += Object.values(result).reduce((sum, count) => sum + count, 0) - before;
  } while (changed > 0 && Date.now() < deadline);
  return result;
}
