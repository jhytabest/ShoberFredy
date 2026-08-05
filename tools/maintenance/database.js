/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../../lib/services/storage/SqliteConnection.js';
import { getMigrationStatus } from '../../lib/services/storage/migrations/migrate.js';
import { buildDatabaseMaintenanceReport } from '../../lib/services/maintenance/databaseReport.js';
import { refreshConfig } from '../../lib/utils.js';

const command = process.argv[2] || 'status';

await SqliteConnection.init();
await refreshConfig();

const db = SqliteConnection.getConnection();
const migrations = getMigrationStatus(db);
let result;
let failed = false;

if (command === 'status' && process.argv.slice(3).length === 0) {
  result = migrations.upToDate
    ? buildDatabaseMaintenanceReport(db)
    : { healthy: false, migrations, error: 'Database schema is not current' };
  failed = !result.healthy;
} else {
  usageError(`Unknown command '${command}'`);
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
SqliteConnection.close();
if (failed) process.exitCode = 1;

function usageError(message) {
  process.stderr.write(`${message}\n\nUsage:\n  yarn maintenance status\n`);
  SqliteConnection.close();
  process.exit(2);
}
