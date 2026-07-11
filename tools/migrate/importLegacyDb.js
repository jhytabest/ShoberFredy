/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Import an existing Fredy listings.db (e.g. from the previous
 * patched-upstream-image deployment) into Shoberfredy.
 *
 * What it does:
 * 1. Opens the source database read-only and sanity-checks the core tables.
 * 2. Snapshots it (SQLite online backup API, WAL-safe — the source may be in
 *    use by a running Fredy) to the configured Shoberfredy database location.
 *    An existing target is backed up next to itself first.
 * 3. Runs the Shoberfredy schema migrations on the imported copy (existing
 *    homeserver_* tables and their data are preserved; migration 22 is
 *    IF NOT EXISTS).
 * 4. Prints before/after row counts for the important tables and verifies
 *    nothing was lost.
 *
 * Usage:
 *   node tools/migrate/importLegacyDb.js --source /path/to/listings.db [--force]
 *
 * --force is required to overwrite an existing target database (a timestamped
 * backup of the target is always taken first).
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const COUNTED_TABLES = [
  'users',
  'jobs',
  'listings',
  'user_settings',
  'settings',
  'watch_list',
  'homeserver_geocode_cache',
  'homeserver_listing_scores',
  'homeserver_model_runs',
  'homeserver_listing_market_model',
  'homeserver_market_surface_cells',
  'homeserver_model_state',
];

function parseArgs(argv) {
  const args = { force: false, source: null, target: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') args.force = true;
    else if (arg === '--source') args.source = argv[++i];
    else if (arg === '--target') args.target = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.source) {
    throw new Error(
      'Usage: node tools/migrate/importLegacyDb.js --source /path/to/listings.db [--target path] [--force]',
    );
  }
  return args;
}

function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

function countTables(db) {
  const counts = {};
  for (const table of COUNTED_TABLES) {
    counts[table] = tableExists(db, table) ? db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n : null;
  }
  return counts;
}

async function main() {
  const args = parseArgs(process.argv);

  const sourcePath = path.resolve(args.source);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source database not found: ${sourcePath}`);
  }

  // Resolve the target the same way the app resolves its own database.
  let targetPath;
  if (args.target) {
    targetPath = path.resolve(args.target);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  } else {
    const { computeDbPath } = await import('../../lib/services/storage/SqliteConnection.js');
    targetPath = (await computeDbPath()).dbPath;
  }

  if (path.resolve(targetPath) === sourcePath) {
    throw new Error('Source and target are the same file; nothing to import.');
  }

  // 1. Validate the source.
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  source.pragma('busy_timeout = 30000');
  for (const required of ['users', 'jobs', 'listings']) {
    if (!tableExists(source, required)) {
      throw new Error(`Source database is missing the '${required}' table — not a Fredy listings.db?`);
    }
  }
  const sourceCounts = countTables(source);
  console.log('source:', sourcePath);
  console.log('source counts:', JSON.stringify(sourceCounts));

  // 2. Back up an existing target, then snapshot the source over it.
  if (fs.existsSync(targetPath)) {
    if (!args.force) {
      throw new Error(`Target ${targetPath} already exists. Re-run with --force to replace it (a backup is taken).`);
    }
    const backupPath = `${targetPath}.pre-import-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(targetPath, backupPath);
    console.log('existing target backed up to:', backupPath);
    // Remove stale WAL/SHM companions so the imported file starts clean.
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(targetPath + suffix)) fs.rmSync(targetPath + suffix);
    }
  }

  // The online backup API produces a consistent snapshot including WAL
  // content, even while the source is being written by a live instance.
  await source.backup(targetPath);
  source.close();
  console.log('snapshot written to:', targetPath);

  // 3. Run Shoberfredy migrations against the imported copy. When the target
  // is not the configured location, point the migration runner's connection
  // at it explicitly is not possible (singleton reads conf/config.json), so
  // we only auto-migrate the configured location.
  const { computeDbPath } = await import('../../lib/services/storage/SqliteConnection.js');
  const configuredPath = (await computeDbPath()).dbPath;
  if (path.resolve(targetPath) === path.resolve(configuredPath)) {
    const { default: SqliteConnection } = await import('../../lib/services/storage/SqliteConnection.js');
    await SqliteConnection.init();
    const { runMigrations } = await import('../../lib/services/storage/migrations/migrate.js');
    await runMigrations();
    if (process.exitCode === 1) {
      throw new Error('Schema migrations failed on the imported database — see log above.');
    }
    SqliteConnection.close();
  } else {
    console.log(
      `NOTE: target is not the configured database (${configuredPath}); ` +
        'run `yarn migratedb` against it separately before starting the app.',
    );
  }

  // 4. Verify.
  const target = new Database(targetPath, { readonly: true, fileMustExist: true });
  const targetCounts = countTables(target);
  target.close();
  console.log('imported counts:', JSON.stringify(targetCounts));

  const lost = Object.entries(sourceCounts).filter(
    ([table, n]) => n != null && (targetCounts[table] == null || targetCounts[table] < n),
  );
  if (lost.length > 0) {
    throw new Error(`Row loss detected for: ${lost.map(([table]) => table).join(', ')}`);
  }
  console.log('import OK — no rows lost.');
}

await main();
