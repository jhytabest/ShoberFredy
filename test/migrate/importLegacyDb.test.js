/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = path.join(ROOT, 'tools', 'migrate', 'importLegacyDb.js');

function buildLegacyDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, notification_adapter TEXT);
    CREATE TABLE listings (id TEXT PRIMARY KEY, job_id TEXT, title TEXT, price REAL);
    CREATE TABLE homeserver_geocode_cache (
      address_key TEXT PRIMARY KEY, source_address TEXT NOT NULL, status TEXT NOT NULL,
      latitude REAL, longitude REAL, accuracy TEXT NOT NULL, place_id TEXT,
      formatted_address TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  db.prepare(`INSERT INTO users VALUES ('u1', 'admin')`).run();
  db.prepare(`INSERT INTO jobs VALUES ('j1', '[]')`).run();
  const insert = db.prepare(`INSERT INTO listings VALUES (?, 'j1', ?, ?)`);
  for (let i = 0; i < 25; i += 1) insert.run(`l${i}`, `Listing ${i}`, 500 + i);
  db.prepare(
    `INSERT INTO homeserver_geocode_cache VALUES ('k1', 'Torstraße 12', 'ok', 52.5, 13.4, 'house', null, null, null, 1, 1, 1)`,
  ).run();
  db.close();
}

describe('importLegacyDb', () => {
  let workDir;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoberfredy-import-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function runTool(args) {
    return execFileSync('node', [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });
  }

  it('imports a legacy database into an explicit target and preserves rows', () => {
    const sourcePath = path.join(workDir, 'legacy.db');
    const targetPath = path.join(workDir, 'imported', 'listings.db');
    buildLegacyDb(sourcePath);

    const output = runTool(['--source', sourcePath, '--target', targetPath]);
    expect(output).toContain('import OK');

    const target = new Database(targetPath, { readonly: true });
    expect(target.prepare('SELECT count(*) AS n FROM listings').get().n).toBe(25);
    expect(target.prepare('SELECT count(*) AS n FROM users').get().n).toBe(1);
    expect(target.prepare('SELECT count(*) AS n FROM homeserver_geocode_cache').get().n).toBe(1);
    target.close();
  });

  it('refuses to overwrite an existing target without --force', () => {
    const sourcePath = path.join(workDir, 'legacy.db');
    const targetPath = path.join(workDir, 'listings.db');
    buildLegacyDb(sourcePath);
    fs.writeFileSync(targetPath, 'existing');

    expect(() => runTool(['--source', sourcePath, '--target', targetPath])).toThrow(/--force/);
  });

  it('overwrites with --force and leaves a backup of the old target', () => {
    const sourcePath = path.join(workDir, 'legacy.db');
    const targetPath = path.join(workDir, 'listings.db');
    buildLegacyDb(sourcePath);
    buildLegacyDb(targetPath);

    const output = runTool(['--source', sourcePath, '--target', targetPath, '--force']);
    expect(output).toContain('backed up to');
    const backups = fs.readdirSync(workDir).filter((f) => f.startsWith('listings.db.pre-import-'));
    expect(backups).toHaveLength(1);
  });

  it('rejects a non-fredy database', () => {
    const sourcePath = path.join(workDir, 'other.db');
    const db = new Database(sourcePath);
    db.exec('CREATE TABLE foo (id INTEGER)');
    db.close();

    expect(() => runTool(['--source', sourcePath, '--target', path.join(workDir, 'x.db')])).toThrow(/missing/);
  });
});
