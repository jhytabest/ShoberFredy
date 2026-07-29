/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'crypto';
import { nanoid } from 'nanoid';
import SqliteConnection from '../storage/SqliteConnection.js';

/**
 * Persist an LLM request before it leaves the server. Authorization headers
 * are never part of the payload. Inline image bytes are replaced by a digest
 * so database-only backups do not become media backups.
 */
export function beginLlmAudit({ context = {}, model, toolName, request }) {
  const id = nanoid();
  const db = SqliteConnection.getConnection();
  const requestJson = JSON.stringify(sanitizeMedia(request));
  db.prepare(
    `INSERT INTO llm_call_audit (
       id, queue_id, listing_id, operation, model, tool_name,
       request_sha256, request_bytes, outcome, started_at
     ) VALUES (
       @id, @queueId, @listingId, @operation, @model, @toolName,
       @requestSha256, @requestBytes, 'started', @startedAt
     )`,
  ).run({
    id,
    queueId: context.queueId ?? null,
    listingId: context.listingId ?? null,
    operation: context.operation || 'text',
    model,
    toolName,
    requestSha256: crypto.createHash('sha256').update(requestJson).digest('hex'),
    requestBytes: Buffer.byteLength(requestJson),
    startedAt: Date.now(),
  });
  return id;
}

export function finishLlmAudit(id, patch) {
  const responseBody = patch.responseBody == null ? '' : String(patch.responseBody);
  SqliteConnection.execute(
    `UPDATE llm_call_audit SET
       response_sha256 = @responseSha256,
       response_bytes = @responseBytes,
       response_headers_json = @responseHeadersJson,
       usage_json = @usageJson,
       http_status = @httpStatus,
       outcome = @outcome,
       error = @error,
       completed_at = @completedAt
     WHERE id = @id`,
    {
      id,
      responseSha256: responseBody ? crypto.createHash('sha256').update(responseBody).digest('hex') : null,
      responseBytes: responseBody ? Buffer.byteLength(responseBody) : null,
      responseHeadersJson: patch.responseHeaders ? JSON.stringify(patch.responseHeaders) : null,
      usageJson: patch.usage ? JSON.stringify(patch.usage) : null,
      httpStatus: patch.httpStatus ?? null,
      outcome: patch.outcome,
      error: patch.error ? String(patch.error).slice(0, 8000) : null,
      completedAt: Date.now(),
    },
  );
}

/*
 * There used to be a `markInterruptedLlmAudits()` here, run once at startup to
 * close every row still marked 'started' by the process that died. It existed
 * because crash recovery was ad hoc per queue. It is gone: the work item that
 * made the call is reclaimed when its lease expires, and the audit row keeps the
 * 'started' outcome, which is the truth — nobody ever read the response. Turning
 * that into 'aborted_restart' at startup only made a permanently open call look
 * like it had been dealt with.
 */

function sanitizeMedia(value) {
  if (Array.isArray(value)) return value.map(sanitizeMedia);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'url' && typeof item === 'string' && item.startsWith('data:image/')) {
      result[key] = {
        media_omitted: true,
        sha256: crypto.createHash('sha256').update(item).digest('hex'),
        encoded_bytes: Buffer.byteLength(item),
      };
    } else {
      result[key] = sanitizeMedia(item);
    }
  }
  return result;
}
