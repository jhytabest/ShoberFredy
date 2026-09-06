/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'crypto';
import { redact } from '../logger.js';
import { nanoid } from 'nanoid';
import SqliteConnection from '../storage/SqliteConnection.js';

export function beginLlmAudit({ context = {}, model, toolName, request }) {
  const id = nanoid();
  const db = SqliteConnection.getConnection();
  const requestJson = JSON.stringify(redact(sanitizeMedia(request)));
  db.prepare(
    `INSERT INTO llm_call_audit (
       id, queue_id, listing_id, operation, model, tool_name,
       request_sha256, request_bytes, request_json, outcome, started_at
     ) VALUES (
       @id, @queueId, @listingId, @operation, @model, @toolName,
       @requestSha256, @requestBytes, @requestJson, 'started', @startedAt
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
    requestJson,
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
       response_json = @responseJson,
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
      responseJson: responseBody ? redact(responseBody) : null,
      responseHeadersJson: patch.responseHeaders
        ? JSON.stringify(
            Object.fromEntries(
              Object.entries(patch.responseHeaders).filter(([key]) =>
                /^(content-type|retry-after|x-ratelimit-|x-request-id)/i.test(key),
              ),
            ),
          )
        : null,
      usageJson: patch.usage ? JSON.stringify(patch.usage) : null,
      httpStatus: patch.httpStatus ?? null,
      outcome: patch.outcome,
      error: patch.error ? String(patch.error).slice(0, 8000) : null,
      completedAt: Date.now(),
    },
  );
}

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
