/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('runDbMaintenance', () => {
  let db;
  let maintenance;
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const old = now - 40 * DAY;
  const recent = now - 2 * DAY;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE parsing_queue (id TEXT PRIMARY KEY, status TEXT, capture_json TEXT, completed_at INTEGER, updated_at INTEGER);
      CREATE TABLE detail_fetch_queue (id TEXT PRIMARY KEY, status TEXT, capture_json TEXT, completed_at INTEGER, updated_at INTEGER);
      CREATE TABLE llm_call_audit (id TEXT PRIMARY KEY, request_json TEXT, response_body TEXT, response_headers_json TEXT, outcome TEXT, started_at INTEGER, completed_at INTEGER);
    `);
    db.prepare('INSERT INTO parsing_queue VALUES (?,?,?,?,?)').run('old-done', 'completed', '{"big":1}', old, old);
    db.prepare('INSERT INTO parsing_queue VALUES (?,?,?,?,?)').run(
      'recent-done',
      'completed',
      '{"big":1}',
      recent,
      recent,
    );
    db.prepare('INSERT INTO parsing_queue VALUES (?,?,?,?,?)').run('old-pending', 'pending', '{"big":1}', null, old);
    db.prepare('INSERT INTO llm_call_audit VALUES (?,?,?,?,?,?,?)').run(
      'old-call',
      '{"req":1}',
      'resp',
      '{}',
      'success',
      old,
      old,
    );
    db.prepare('INSERT INTO llm_call_audit VALUES (?,?,?,?,?,?,?)').run(
      'recent-call',
      '{"req":1}',
      'resp',
      '{}',
      'success',
      recent,
      recent,
    );

    vi.resetModules();
    vi.doMock('../../lib/services/storage/SqliteConnection.js', () => ({
      default: { getConnection: () => db },
    }));
    maintenance = await import('../../lib/services/crons/db-maintenance-cron.js');
  });

  afterEach(() => {
    vi.resetModules();
    db.close();
  });

  it('clears heavy payloads on aged terminal rows but keeps recent and active rows', () => {
    const summary = maintenance.runDbMaintenance({ now });
    expect(summary.parsingCleared).toBe(1);
    expect(summary.auditCleared).toBe(1);

    expect(db.prepare("SELECT capture_json FROM parsing_queue WHERE id = 'old-done'").get().capture_json).toBeNull();
    expect(
      db.prepare("SELECT capture_json FROM parsing_queue WHERE id = 'recent-done'").get().capture_json,
    ).not.toBeNull();
    expect(
      db.prepare("SELECT capture_json FROM parsing_queue WHERE id = 'old-pending'").get().capture_json,
    ).not.toBeNull();

    const oldCall = db
      .prepare("SELECT request_json, response_body, outcome FROM llm_call_audit WHERE id = 'old-call'")
      .get();
    expect(oldCall.request_json).toBeNull();
    expect(oldCall.response_body).toBeNull();
    expect(oldCall.outcome).toBe('success'); // audit metadata preserved
    expect(
      db.prepare("SELECT request_json FROM llm_call_audit WHERE id = 'recent-call'").get().request_json,
    ).not.toBeNull();
  });

  it('is idempotent (a second run clears nothing more)', () => {
    maintenance.runDbMaintenance({ now });
    const summary = maintenance.runDbMaintenance({ now });
    expect(summary.parsingCleared).toBe(0);
    expect(summary.auditCleared).toBe(0);
  });
});
