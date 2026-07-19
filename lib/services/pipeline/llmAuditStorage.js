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
  ensureAuditTable(db);
  db.prepare(
    `INSERT INTO llm_call_audit (
       id, queue_id, listing_id, queue_kind, operation, model, tool_name,
       request_json, outcome, started_at
     ) VALUES (
       @id, @queueId, @listingId, @queueKind, @operation, @model, @toolName,
       @requestJson, 'started', @startedAt
     )`,
  ).run({
    id,
    queueId: context.queueId ?? null,
    listingId: context.listingId ?? null,
    queueKind: context.queueKind === 'backfill' ? 'backfill' : 'live',
    operation: context.operation || 'text',
    model,
    toolName,
    requestJson: JSON.stringify(sanitizeMedia(request)),
    startedAt: Date.now(),
  });
  return id;
}

function ensureAuditTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_call_audit (
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
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_queue
      ON llm_call_audit (queue_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_listing
      ON llm_call_audit (listing_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_outcome
      ON llm_call_audit (outcome, started_at);
  `);
}

export function finishLlmAudit(id, patch) {
  SqliteConnection.execute(
    `UPDATE llm_call_audit SET
       response_body = @responseBody,
       response_headers_json = @responseHeadersJson,
       usage_json = @usageJson,
       http_status = @httpStatus,
       outcome = @outcome,
       error = @error,
       completed_at = @completedAt
     WHERE id = @id`,
    {
      id,
      responseBody: patch.responseBody ?? null,
      responseHeadersJson: patch.responseHeaders ? JSON.stringify(patch.responseHeaders) : null,
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
