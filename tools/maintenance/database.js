/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../../lib/services/storage/SqliteConnection.js';
import { getMigrationStatus } from '../../lib/services/storage/migrations/migrate.js';
import { buildDatabaseMaintenanceReport } from '../../lib/services/maintenance/databaseReport.js';
import { getSettings, upsertSettings } from '../../lib/services/storage/settingsStorage.js';
import { refreshConfig } from '../../lib/utils.js';
import { JOBS_USAGE, runJobs } from './jobsCommand.js';
import { retainAuditPayloads } from '../../lib/services/maintenance/payloadRetention.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { clearExtractionPause } from '../../lib/services/pipeline/llmBudget.js';
import { JobDocumentError } from '../../lib/services/storage/jobDocument.js';

const USAGE = `Usage:
  yarn maintenance status
  yarn maintenance prune-audit
  yarn maintenance resume-llm
  yarn maintenance settings list
  yarn maintenance settings get <name>
  yarn maintenance settings set <name> <json-value>
  yarn maintenance settings unset <name>
${JOBS_USAGE}

Values are JSON, so quote strings:
  yarn maintenance jobs set <id> blacklist '["Tausch","Untermiete"]'
`;

// Settings and jobs written straight into SQLite are invisible and easy to get
// wrong (the columns are JSON, not text). These live behind the same helpers the
// application reads through, so a value set here is a value the pipeline sees,
// and a job written here is one every stage can read.
const command = process.argv[2] || 'status';
const args = process.argv.slice(3);

await SqliteConnection.init();
await refreshConfig();

const db = SqliteConnection.getConnection();
let result;
let failed = false;

if (command === 'status' && args.length === 0) {
  const migrations = getMigrationStatus(db);
  result = migrations.upToDate
    ? buildDatabaseMaintenanceReport(db)
    : { healthy: false, migrations, error: 'Database schema is not current' };
  failed = !result.healthy;
} else if (command === 'prune-audit' && args.length === 0) {
  await runMigrations();
  if (process.exitCode) throw new Error('Migration failed; audit cleanup stopped');
  result = retainAuditPayloads(db, Date.now(), { timeBudgetMs: Infinity });
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
} else if (command === 'resume-llm' && args.length === 0) {
  clearExtractionPause();
  result = { resumed: true };
} else if (command === 'settings') {
  result = await runSettings(args);
} else if (command === 'jobs') {
  try {
    result = await runJobs(args, { usageError });
  } catch (error) {
    if (!(error instanceof JobDocumentError)) throw error;
    usageError(`That job would not be read as written:\n  ${error.problems.join('\n  ')}`);
  }
} else {
  usageError(`Unknown command '${command}'`);
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
SqliteConnection.close();
if (failed) process.exitCode = 1;

async function runSettings([action, name, rawValue]) {
  if (action === 'list' && !name) {
    return await getSettings();
  }
  if (action === 'get' && name) {
    const settings = await getSettings();
    if (!(name in settings)) usageError(`No setting named '${name}'`);
    return { [name]: settings[name] };
  }
  if (action === 'set' && name && rawValue !== undefined) {
    let value;
    try {
      value = JSON.parse(rawValue);
    } catch {
      usageError(`Value for '${name}' must be JSON (strings need quotes): ${rawValue}`);
    }
    if (value === null) usageError(`Use 'settings unset ${name}' to remove a setting`);
    upsertSettings({ [name]: value });
    return { [name]: value };
  }
  if (action === 'unset' && name) {
    upsertSettings({ [name]: null });
    return { [name]: null };
  }
  return usageError(`Unknown settings command '${[action, name].filter(Boolean).join(' ')}'`);
}

function usageError(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  SqliteConnection.close();
  process.exit(2);
}
