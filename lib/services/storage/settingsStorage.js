/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { nanoid } from 'nanoid';
import SqliteConnection from './SqliteConnection.js';
import { fromJson, readConfigFromStorage, toJson } from '../../utils.js';

// Only the file half of the config is cached. `conf/config.json` carries
// deployment-level values (the SQLite directory) that cannot change without a
// redeploy, so reading it once is right; the `settings` table is operator state
// that changes underneath a running process and must not be.
/** @type {Record<string, any>|null} */
let cachedFileConfig = null;

/**
 * Build a config object from DB rows of settings.
 * - Unwraps stored shape { value: any } into raw values.
 * - Add additional config values from file config. E.g. sqlite part cannot be stored in db for obvious reasons ;)
 * @param {{name:string, value:string|null}[]} rows
 * @param {{name:value}} configValues
 * @returns {Record<string, any>}
 */
function compileSettings(rows, configValues) {
  const config = {};
  for (const r of rows) {
    const parsed = fromJson(r.value, null);
    // unwrap { value: any } if present
    config[r.name] = parsed && typeof parsed === 'object' && 'value' in parsed ? parsed.value : parsed;
  }
  return {
    ...configValues,
    ...config,
  };
}

/**
 * The deployment-level config, read from disk once.
 * @returns {Promise<Record<string, any>>}
 */
async function fileConfig() {
  if (cachedFileConfig == null) cachedFileConfig = await readConfigFromStorage();
  return cachedFileConfig;
}

/**
 * Retrieves user-specific settings from the database.
 * @param {string} userId
 * @returns {Record<string, any>}
 */
export function getUserSettings(userId) {
  if (!userId || typeof userId !== 'string') {
    return {};
  }
  const userRows = SqliteConnection.query(`SELECT name, value FROM settings WHERE user_id = @userId`, { userId });
  return compileSettings(userRows, {});
}

/**
 * The compiled settings config, read fresh from the database on every call.
 *
 * This is deliberately not memoised. There is no UI: `proxyUrl` and friends are
 * written straight into the `settings` table by cron, from outside this process,
 * so a process-lifetime cache never observes them. That is not hypothetical — a
 * proxy written 86 minutes after startup stayed invisible until the container was
 * recreated, and Immowelt was skipped for every discovery run in between while
 * the setting sat in the database the whole time.
 *
 * A modification watermark would not fix it either: `upsertSettings` sets
 * `create_date` on INSERT only, so updating an existing row leaves every
 * timestamp in the table unchanged.
 *
 * The cost is a handful of rows from a local SQLite file on a path that is
 * already async — immaterial next to the browser session or LLM call that
 * follows it.
 *
 * @returns {Promise<Record<string, any>>}
 */
export async function getSettings() {
  const rows = SqliteConnection.query(`SELECT name, value FROM settings WHERE user_id IS NULL`);
  return compileSettings(rows, await fileConfig());
}

/**
 * Get or create a persistent session signing secret.
 * Generated once and stored in the settings table under the key 'session_secret'.
 * @returns {Promise<string>}
 */
export async function getOrCreateSessionSecret() {
  const settings = await getSettings();
  if (settings.session_secret) return settings.session_secret;
  const secret = nanoid(64);
  upsertSettings({ session_secret: secret });
  return secret;
}

/**
 * Upsert settings rows.
 * - Accepts an object map of name -> value, or an entry {name, value}.
 * - id: random string (nanoid) when inserting
 * - create_date: epoch ms when inserting
 * - name: unique key
 * - value: JSON string of the raw value (no wrapper)
 * @param {Record<string, any>|{name:string, value:any}|[string, any][]} settingsMapOrEntry
 * @returns {void}
 */
// Upsert one or more settings by name. Accepts either a single pair or an object map.
// Preferred usage: upsertSettings({ settingName: any, another: any })
export function upsertSettings(settingsMapOrEntry, userId = null) {
  const entries = Array.isArray(settingsMapOrEntry)
    ? settingsMapOrEntry
    : typeof settingsMapOrEntry === 'object' &&
        settingsMapOrEntry != null &&
        'name' in settingsMapOrEntry &&
        'value' in settingsMapOrEntry
      ? [[settingsMapOrEntry.name, settingsMapOrEntry.value]]
      : Object.entries(settingsMapOrEntry || {});

  for (const [name, rawValue] of entries) {
    if (rawValue === null) {
      SqliteConnection.execute(
        `DELETE FROM settings WHERE name = @name AND (user_id = @userId OR (user_id IS NULL AND @userId IS NULL))`,
        {
          name,
          userId,
        },
      );
    } else {
      const id = nanoid();
      const create_date = Date.now();
      const json = toJson(rawValue);
      SqliteConnection.execute(
        `INSERT INTO settings (id, create_date, name, value, user_id)
       VALUES (@id, @create_date, @name, @value, @userId)
       ON CONFLICT(name, IFNULL(user_id, 'GLOBAL_SETTING')) DO UPDATE SET value = excluded.value`,
        { id, create_date, name, value: json, userId },
      );
    }
  }
  // No cache to invalidate: getSettings() reads the table. A write made here is
  // visible to the next reader for the same reason a write made by cron is.
}
