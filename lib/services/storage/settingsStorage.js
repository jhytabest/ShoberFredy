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

export async function getSettings() {
  const rows = SqliteConnection.query(`SELECT name, value FROM settings`);
  return compileSettings(rows, await fileConfig());
}

export function getBlacklist() {
  const rows = SqliteConnection.query(`SELECT value FROM settings WHERE name = 'blacklist'`);
  const parsed = fromJson(rows[0]?.value, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function upsertSettings(settingsMapOrEntry) {
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
      SqliteConnection.execute(`DELETE FROM settings WHERE name = @name`, { name });
    } else {
      SqliteConnection.execute(
        `INSERT INTO settings (id, create_date, name, value)
       VALUES (@id, @create_date, @name, @value)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
        { id: nanoid(), create_date: Date.now(), name, value: toJson(rawValue) },
      );
    }
  }
}
