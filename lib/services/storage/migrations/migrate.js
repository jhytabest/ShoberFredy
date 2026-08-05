/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import crypto from 'crypto';
import SqliteConnection from '../SqliteConnection.js';
import logger from '../../logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const MIGRATIONS_DIR = path.join(ROOT, 'lib', 'services', 'storage', 'migrations', 'sql');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export function listMigrationFiles() {
  ensureDir(MIGRATIONS_DIR);
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+\..+\.js$/.test(f))
    .map((file) => {
      const [idStr, ...rest] = file.split('.');
      const id = Number.parseInt(idStr, 10);
      const label = rest.slice(0, -1).join('.');
      const fullPath = path.join(MIGRATIONS_DIR, file);
      return { id, name: file, label, path: fullPath };
    })
    .sort((a, b) => (a.id === b.id ? a.name.localeCompare(b.name) : a.id - b.id));
}

export function getMigrationStatus(db = SqliteConnection.getConnection()) {
  const expected = listMigrationFiles();
  const hasLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const applied = new Map(
    hasLedger
      ? db
          .prepare('SELECT name, checksum FROM schema_migrations')
          .all()
          .map(({ name, checksum }) => [name, checksum])
      : [],
  );
  const missing = expected
    .filter(({ name, path: filePath }) => applied.get(name) !== sha256File(filePath))
    .map(({ name }) => name);
  const latestApplied = [...expected].reverse().find(({ name }) => applied.has(name))?.name ?? null;

  return {
    upToDate: missing.length === 0,
    appliedCount: expected.length - missing.length,
    expectedCount: expected.length,
    latestApplied,
    latestExpected: expected.at(-1)?.name ?? null,
    missing,
  };
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function loadMigrationModule(filePath) {
  const url = pathToFileURL(filePath);
  const mod = await import(url.href);
  const fn = mod.up || mod.default;
  if (typeof fn !== 'function') {
    throw new Error(`Migration ${filePath} must export function up(db) or default function(db)`);
  }
  return fn;
}

function loadExecutedMigrations() {
  const executed = new Map();
  const hasTable = SqliteConnection.tableExists('schema_migrations');
  if (!hasTable) return executed;
  const rows = SqliteConnection.query('SELECT name, checksum FROM schema_migrations ORDER BY applied_at ASC');
  for (const r of rows) executed.set(r.name, r.checksum);
  return executed;
}

export async function runMigrations() {
  ensureDir(path.join(ROOT, 'db'));
  ensureDir(MIGRATIONS_DIR);

  const files = listMigrationFiles();
  if (files.length === 0) {
    logger.info('No migration files found under', MIGRATIONS_DIR);
    return;
  }
  if (files.length !== 1) {
    logger.error(`Expected exactly one current-schema migration, found ${files.length}.`);
    process.exitCode = 1;
    return;
  }

  SqliteConnection.getConnection();

  const executed = loadExecutedMigrations();

  let appliedMigrations = 0;
  for (const m of files) {
    const checksum = sha256File(m.path);

    if (executed.get(m.name) === checksum) continue;

    appliedMigrations++;
    logger.info(`Applying migration: ${m.name}`);
    const fn = await loadMigrationModule(m.path);

    const connection = SqliteConnection.getConnection();
    connection.pragma('foreign_keys = OFF');
    try {
      let duration = 0;
      SqliteConnection.withTransaction((db) => {
        const t0 = Date.now();
        fn(db);
        duration = Date.now() - t0;
        db.prepare('DELETE FROM schema_migrations').run();
        db.prepare(
          "INSERT INTO schema_migrations (name, checksum, applied_at, duration_ms) VALUES (?, ?, datetime('now'), ?)",
        ).run(m.name, checksum, duration);
      });
      logger.info(`Migration applied: ${m.name} (${duration} ms)`);
    } catch (e) {
      logger.error(`Migration failed and was rolled back: ${m.name}`, e);
      process.exitCode = 1;
      return;
    } finally {
      connection.pragma('foreign_keys = ON');
    }
  }

  SqliteConnection.optimize();
  if (appliedMigrations > 0) {
    logger.info('All migrations completed successfully.');
  }
}

const isDirectRun = (() => {
  try {
    const thisFile = import.meta.url;
    const invoked = pathToFileURL(process.argv[1] || '').href;
    return thisFile === invoked;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  await runMigrations();
}
