/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { sha256 } from '../../shared/hash.js';
import { redact } from '../logger.js';
import { nanoid } from 'nanoid';
import SqliteConnection from '../storage/SqliteConnection.js';
import { storeAuditPayload, storeRequestManifest } from '../storage/auditPayloadStorage.js';

export function beginLlmAudit({ context = {}, model, toolName, request }) {
  const id = nanoid();
  const db = SqliteConnection.getConnection();
  const wireBody = JSON.stringify(request);
  db.transaction(() => {
    const requestHash = storeRequestManifest(request, db);
    db.prepare(
      `INSERT INTO llm_call_audit (
      id, queue_id, listing_id, operation, model, tool_name,
      request_sha256, request_bytes, request_payload_sha256, attempt_group, model_position, outcome, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
    ).run(
      id,
      context.queueId ?? null,
      context.listingId ?? null,
      context.operation || 'text',
      model,
      toolName,
      sha256(wireBody),
      Buffer.byteLength(wireBody),
      requestHash,
      context.attemptGroup ?? null,
      context.modelPosition ?? null,
      Date.now(),
    );
  })();
  return id;
}

export function finishLlmAudit(id, patch) {
  const db = SqliteConnection.getConnection();
  const body = patch.responseBody == null ? '' : String(patch.responseBody);
  let parsedBody = body;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    /* Preserve non-JSON error bodies too. */
  }
  db.transaction(() => {
    const responseHash = body ? storeAuditPayload(parsedBody, db) : null;
    db.prepare(
      `UPDATE llm_call_audit SET response_sha256 = ?, response_bytes = ?,
      response_payload_sha256 = ?, response_headers_json = ?, usage_json = ?, http_status = ?,
      outcome = ?, error = ?, completed_at = ?, provider = ?, budget_refunded = ? WHERE id = ?`,
    ).run(
      body ? sha256(body) : null,
      Buffer.byteLength(body),
      responseHash,
      patch.responseHeaders
        ? JSON.stringify(
            redact(
              Object.fromEntries(
                Object.entries(patch.responseHeaders).filter(([key]) =>
                  /^(content-type|retry-after|x-ratelimit-|x-request-id)/i.test(key),
                ),
              ),
            ),
          )
        : null,
      patch.usage ? JSON.stringify(redact(patch.usage)) : null,
      patch.httpStatus ?? null,
      patch.outcome,
      patch.error ? redact(String(patch.error)).slice(0, 8000) : null,
      Date.now(),
      patch.provider ?? null,
      patch.budgetRefunded ? 1 : 0,
      id,
    );
  })();
}

export function recordLlmValidation(id, result) {
  SqliteConnection.execute(
    `UPDATE llm_call_audit SET validation_status = @status,
    validation_errors_json = @errors WHERE id = @id`,
    {
      id,
      status: result.valid ? 'valid' : 'invalid',
      errors: JSON.stringify(result.errors),
    },
  );
}
