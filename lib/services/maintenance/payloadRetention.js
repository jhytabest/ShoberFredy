/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { env } from '../../shared/env.js';
import { setTimeout as delay } from 'node:timers/promises';

const BATCH_SIZE = 500;

export async function retainAuditPayloads(db, now = Date.now(), { timeBudgetMs = Infinity, signal } = {}) {
  const cutoff = now - env('FREDY_AUDIT_PAYLOAD_DAYS') * 86400000;
  const result = { auditRecordsDeleted: 0, payloadsDeleted: 0, terminalCapturesTrimmed: 0, legacyInputsTrimmed: 0 };
  const deadline = Date.now() + timeBudgetMs;
  // The cutoff is fixed for this pass. Do not rescan already drained tables
  // for every remaining payload batch; they can be checked again next pass.
  const drained = new Set();
  // A connection-local set lets every reference table be updated once per batch.
  db.exec('CREATE TEMP TABLE IF NOT EXISTS expired_audit_payloads (sha256 TEXT PRIMARY KEY) WITHOUT ROWID');
  let changed;
  do {
    signal?.throwIfAborted();
    const before = Object.values(result).reduce((sum, count) => sum + count, 0);
    db.transaction(() => {
      for (const [table, timestamp] of [
        ['llm_call_audit', 'started_at'],
        ['geocode_call_audit', 'started_at'],
        ['runtime_events', 'created_at'],
        ['discovery_run_audit', 'finished_at'],
        ['pipeline_audit_events', 'created_at'],
      ]) {
        if (drained.has(table)) continue;
        const deleted = db
          .prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${timestamp} < ? LIMIT ?)`)
          .run(cutoff, BATCH_SIZE).changes;
        result.auditRecordsDeleted += deleted;
        if (deleted < BATCH_SIZE) drained.add(table);
      }
      const rows = drained.has('pipeline_work')
        ? []
        : db
            .prepare(
              `SELECT kind, key FROM pipeline_work
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
      }
      result.terminalCapturesTrimmed += rows.length;
      if (rows.length < BATCH_SIZE) drained.add('pipeline_work');
      // These are diagnostic input copies, not the extracted facts or their quotes.
      for (const [table, key, column] of [
        ['listing_extractions', 'queue_id', 'llm_json'],
        ['listing_attributes', 'listing_id', 'data'],
      ]) {
        if (drained.has(table)) continue;
        const trimmed = db
          .prepare(
            `UPDATE ${table} SET ${column} = json_remove(${column}, '$.provenance.input', '$.provenance.inputPayloads')
             WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE parsed_at < ? AND json_valid(${column})
               AND (json_type(${column}, '$.provenance.input') IS NOT NULL
                 OR json_type(${column}, '$.provenance.inputPayloads') IS NOT NULL) LIMIT ?)`,
          )
          .run(cutoff, BATCH_SIZE).changes;
        result.legacyInputsTrimmed += trimmed;
        if (trimmed < BATCH_SIZE) drained.add(table);
      }
      db.exec('DELETE FROM expired_audit_payloads');
      db.prepare(
        `INSERT INTO expired_audit_payloads
         SELECT p.sha256 FROM audit_payloads p WHERE p.expires_at <= ?
           AND NOT EXISTS (SELECT 1 FROM audit_payload_edges e JOIN audit_payloads parent
             ON parent.sha256 = e.parent_sha256 WHERE e.child_sha256 = p.sha256 AND parent.expires_at > ?)
         ORDER BY p.expires_at LIMIT ?`,
      ).run(now, now, BATCH_SIZE);
      const expired = '(SELECT sha256 FROM expired_audit_payloads)';
      for (const [table, column] of [
        ['llm_call_audit', 'request_payload_sha256'],
        ['llm_call_audit', 'response_payload_sha256'],
        ['geocode_call_audit', 'result_payload_sha256'],
        ['runtime_events', 'payload_sha256'],
        ['listing_source_observations', 'payload_sha256'],
      ]) {
        db.prepare(`UPDATE ${table} SET ${column} = NULL WHERE ${column} IN ${expired}`).run();
      }
      db.prepare(
        `DELETE FROM audit_payload_edges WHERE parent_sha256 IN ${expired} OR child_sha256 IN ${expired}`,
      ).run();
      result.payloadsDeleted += db.prepare(`DELETE FROM audit_payloads WHERE sha256 IN ${expired}`).run().changes;
    })();
    changed = Object.values(result).reduce((sum, count) => sum + count, 0) - before;
    // Commit before yielding: scraping, delivery and cancellation remain responsive
    // while a backlog drains. Never await inside a SQLite transaction.
    if (changed > 0) await delay(10, undefined, { signal });
  } while (changed > 0 && Date.now() < deadline);
  return result;
}
