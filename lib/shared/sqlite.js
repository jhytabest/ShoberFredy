/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function columnExists(db, table, column) {
  return Boolean(db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column));
}
