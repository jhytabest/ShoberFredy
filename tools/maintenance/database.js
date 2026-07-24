/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Safe database maintenance toolkit.
 *
 * Read-only unless --apply is present:
 *   yarn maintenance status
 *   yarn maintenance dedupe
 *   yarn maintenance dedupe --apply
 *   yarn maintenance clean
 *   yarn maintenance clean --apply
 *   yarn maintenance clean --apply --vacuum
 *   yarn maintenance verify-archives
 */

import SqliteConnection from '../../lib/services/storage/SqliteConnection.js';
import { getMigrationStatus } from '../../lib/services/storage/migrations/migrate.js';
import {
  applyCanonicalDedupe,
  findCanonicalDuplicateClusters,
  summarizeCanonicalDuplicates,
} from '../../lib/services/maintenance/canonicalDedupe.js';
import {
  buildDatabaseMaintenanceReport,
  verifyArchivePayloads,
} from '../../lib/services/maintenance/databaseReport.js';
import { previewDbMaintenance, runDbMaintenance } from '../../lib/services/maintenance/databaseCleanup.js';
import { refreshConfig } from '../../lib/utils.js';

const command = process.argv[2] || 'status';
const flags = new Set(process.argv.slice(3));
const apply = flags.has('--apply');
const vacuum = flags.has('--vacuum');

await SqliteConnection.init();
await refreshConfig();

const db = SqliteConnection.getConnection();
const migrations = getMigrationStatus(db);
let result;
let failed = false;

if (command === 'status') {
  requireNoMutationFlags();
  result = migrations.upToDate
    ? buildDatabaseMaintenanceReport(db)
    : { healthy: false, migrations, error: 'Database schema is not current' };
  failed = !result.healthy;
} else if (command === 'dedupe') {
  requireCurrentSchema();
  if (vacuum) usageError('--vacuum is only valid with clean --apply');
  result = apply
    ? { mode: 'applied', ...applyCanonicalDedupe(db) }
    : { mode: 'preview', ...summarizeCanonicalDuplicates(findCanonicalDuplicateClusters(db)) };
} else if (command === 'clean') {
  requireCurrentSchema();
  if (vacuum && !apply) usageError('--vacuum requires --apply');
  result = apply
    ? { mode: 'applied', ...runDbMaintenance({ vacuum }) }
    : { mode: 'preview', ...previewDbMaintenance() };
} else if (command === 'verify-archives') {
  requireCurrentSchema();
  requireNoMutationFlags();
  result = verifyArchivePayloads(db);
  failed = !result.valid;
} else {
  usageError(`Unknown command '${command}'`);
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
SqliteConnection.close();
if (failed) process.exitCode = 1;

function requireNoMutationFlags() {
  if (apply || vacuum) usageError(`'${command}' is read-only and accepts no mutation flags`);
}

function requireCurrentSchema() {
  if (!migrations.upToDate) {
    usageError(`Database schema is not current; missing: ${migrations.missing.join(', ')}`);
  }
}

function usageError(message) {
  process.stderr.write(
    `${message}\n\nUsage:\n` +
      `  yarn maintenance status\n` +
      `  yarn maintenance dedupe [--apply]\n` +
      `  yarn maintenance clean [--apply] [--vacuum]\n` +
      `  yarn maintenance verify-archives\n`,
  );
  SqliteConnection.close();
  process.exit(2);
}
