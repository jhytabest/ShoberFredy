/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { sha256 } from '../../shared/hash.js';
import { env } from '../../shared/env.js';
import { redact } from '../logger.js';
import SqliteConnection from './SqliteConnection.js';

// Rows survive expiry as small tombstones: historical references never dangle.
// A later use of the same content restores its body and extends its retention.
export function storeAuditPayload(
  value,
  db = SqliteConnection.getConnection(),
  now = Date.now(),
  { permanent = false } = {},
) {
  const body = JSON.stringify(redact(value));
  const hash = sha256(body);
  const bytes = Buffer.byteLength(body);
  const keep = permanent || bytes <= 2048;
  db.prepare(
    `INSERT INTO audit_payloads (sha256, body_json, byte_size, created_at, expires_at, permanent)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO UPDATE SET
    body_json = excluded.body_json, expires_at = MAX(expires_at, excluded.expires_at),
    permanent = MAX(permanent, excluded.permanent), trimmed_at = NULL`,
  ).run(hash, body, bytes, now, now + env('FREDY_AUDIT_PAYLOAD_DAYS') * 86400000, keep ? 1 : 0);
  return hash;
}

export function readAuditPayload(hash, db = SqliteConnection.getConnection()) {
  const row = db.prepare('SELECT body_json FROM audit_payloads WHERE sha256 = ?').get(hash);
  return row?.body_json == null ? null : JSON.parse(row.body_json);
}

export function storeRequestManifest(request, db = SqliteConnection.getConnection()) {
  // Prompts, tool schemas and evidence are shared across listings, models and retries.
  const { messages, tools, ...parameters } = request;
  const toolHash = storeAuditPayload(tools, db, Date.now(), { permanent: true });
  const messageHashes = messages.map((message) =>
    storeAuditPayload(message, db, Date.now(), { permanent: message.role === 'system' }),
  );
  const manifest = storeAuditPayload(
    {
      format: 'request-manifest-v1',
      parameters,
      tools: toolHash,
      messages: messageHashes,
    },
    db,
  );
  for (const [position, hash] of [toolHash, ...messageHashes].entries()) {
    db.prepare('INSERT OR IGNORE INTO audit_payload_edges(parent_sha256, position, child_sha256) VALUES (?, ?, ?)').run(
      manifest,
      position,
      hash,
    );
  }
  return manifest;
}

export function readLlmRequest(auditId, db = SqliteConnection.getConnection()) {
  const row = db.prepare('SELECT request_json, request_payload_sha256 FROM llm_call_audit WHERE id = ?').get(auditId);
  if (!row) return null;
  if (row.request_json) return JSON.parse(row.request_json);
  const manifest = readAuditPayload(row.request_payload_sha256, db);
  if (!manifest) return null;
  const tools = readAuditPayload(manifest.tools, db);
  const messages = manifest.messages.map((hash) => readAuditPayload(hash, db));
  if (!tools || messages.some((message) => !message)) return null;
  return { ...manifest.parameters, messages, tools };
}
