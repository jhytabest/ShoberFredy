/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { nanoid } from 'nanoid';
import SqliteConnection from './SqliteConnection.js';
import { fromJson, readConfigFromStorage, toJson } from '../../utils.js';

let cachedFileConfig = null;

function compileSettings(rows, configValues) {
  const config = {};
  for (const r of rows) {
    const parsed = fromJson(r.value, null);
    config[r.name] = parsed && typeof parsed === 'object' && 'value' in parsed ? parsed.value : parsed;
  }
  return {
    ...configValues,
    ...config,
  };
}

async function fileConfig() {
  if (cachedFileConfig == null) cachedFileConfig = await readConfigFromStorage();
  return cachedFileConfig;
}

export function getUserSettings(userId) {
  if (!userId || typeof userId !== 'string') {
    return {};
  }
  const userRows = SqliteConnection.query(`SELECT name, value FROM settings WHERE user_id = @userId`, { userId });
  return compileSettings(userRows, {});
}

export async function getSettings() {
  const rows = SqliteConnection.query(`SELECT name, value FROM settings WHERE user_id IS NULL`);
  return compileSettings(rows, await fileConfig());
}

export function getBlacklist() {
  const rows = SqliteConnection.query(`SELECT value FROM settings WHERE user_id IS NULL AND name = 'blacklist'`);
  const parsed = fromJson(rows[0]?.value, []);
  return Array.isArray(parsed) ? parsed : [];
}

export async function getOrCreateSessionSecret() {
  const settings = await getSettings();
  if (settings.session_secret) return settings.session_secret;
  const secret = nanoid(64);
  upsertSettings({ session_secret: secret });
  return secret;
}

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
}
