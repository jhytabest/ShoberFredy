/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Read-only-runtime entrypoint for a local copy of the live deployment.
 *
 * The normal entrypoint starts discovery, detail fetching, LLM parsing,
 * geocoding, rating, notifications, model training, and maintenance jobs. A
 * mirror must expose the copied UI and API without duplicating those live side
 * effects, so this entrypoint initializes storage and starts only the API.
 *
 * The mirror's Docker network has no external route as a second safety layer.
 * API writes made through the UI affect only the disposable local copy.
 */

import fs from 'fs';
import { checkIfConfigIsAccessible, refreshConfig } from '../lib/utils.js';
import SqliteConnection from '../lib/services/storage/SqliteConnection.js';
import { runMigrations } from '../lib/services/storage/migrations/migrate.js';
import logger from '../lib/services/logger.js';

if (fs.existsSync('.env.local') && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile('.env.local');
}

const isConfigAccessible = await checkIfConfigIsAccessible();
if (!isConfigAccessible) {
  throw new Error('Mirror configuration is not accessible.');
}

await SqliteConnection.init();
await refreshConfig();
await runMigrations();
if (process.exitCode) throw new Error('Mirror database migration failed.');
await import('../lib/api/api.js');

logger.info('Local live-state mirror started in isolated API-only mode.');
