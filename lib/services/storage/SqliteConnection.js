/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import logger from '../../services/logger.js';
import { readConfigFromStorage } from '../../utils.js';

class SqliteConnection {
  static #db = null;

  static #sqlLiteCfg = null;

  static async init() {
    if (this.#sqlLiteCfg == null) {
      const c = await readConfigFromStorage();
      this.#sqlLiteCfg = c.sqlitepath;
    }
  }
  static getConnection() {
    if (this.#db) return this.#db;

    if (this.#sqlLiteCfg == null) {
      logger.warn('No sqlitepath configured. Using default db/listings.db');
    }

    const rawDir = this.#sqlLiteCfg && this.#sqlLiteCfg.length > 0 ? this.#sqlLiteCfg : '/db';
    const relDir = rawDir.startsWith('/') ? rawDir.slice(1) : rawDir;
    const absDir = path.isAbsolute(relDir) ? relDir : path.join(process.cwd(), relDir);
    const dbPath = path.join(absDir, 'listings.db');

    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.#db = new Database(dbPath, { verbose: undefined });

    try {
      this.#db.pragma('journal_mode = WAL');
      this.#db.pragma('busy_timeout = 30000');
      this.#db.pragma('synchronous = NORMAL');
      this.#db.pragma('cache_size = -64000');
      this.#db.pragma('foreign_keys = ON');
      this.#db.pragma('optimize');
    } catch (e) {
      logger.warn('Failed to apply one or more PRAGMAs:', e.message);
    }

    process.once('beforeExit', () => {
      try {
        this.#db?.pragma('optimize');
      } catch (e) {
        logger.debug('PRAGMA optimize on exit failed:', e.message);
      }
    });

    return this.#db;
  }

  static execute(sql, params = {}) {
    const db = this.getConnection();
    return db.prepare(sql).run(params);
  }

  static query(sql, params = {}) {
    const db = this.getConnection();
    return db.prepare(sql).all(params);
  }

  static tableExists(tableName) {
    const db = this.getConnection();
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
    return !!row;
  }

  static withTransaction(callback) {
    const db = this.getConnection();
    const trx = db.transaction((cb) => cb(db));
    return trx(callback);
  }

  static optimize() {
    const db = this.getConnection();
    try {
      db.pragma('optimize');
    } catch (e) {
      logger.warn('PRAGMA optimize failed:', e.message);
    }
  }

  static close() {
    if (this.#db) {
      try {
        this.#db.pragma('optimize');
      } catch (e) {
        logger.debug('PRAGMA optimize before close failed:', e.message);
      }
      this.#db.close();
      this.#db = null;
    }
  }
}

export default SqliteConnection;

export async function computeDbPath() {
  const cfg = await readConfigFromStorage();
  const rawDir = cfg?.sqlitepath && cfg.sqlitepath.length > 0 ? cfg.sqlitepath : '/db';
  const relDir = rawDir.startsWith('/') ? rawDir.slice(1) : rawDir;
  const absDir = path.isAbsolute(relDir) ? relDir : path.join(process.cwd(), relDir);
  const dbPath = path.join(absDir, 'listings.db');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return { dir: absDir, dbPath };
}
