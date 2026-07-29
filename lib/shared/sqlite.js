/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Schema introspection, used by migrations, the exporter and maintenance work.
 * Both helpers take an explicit `db` so they work against any handle, including
 * the read-only one the exporter opens in its own process.
 */

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @returns {boolean}
 */
export function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @param {string} column
 * @returns {boolean}
 */
export function columnExists(db, table, column) {
  return Boolean(db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column));
}
