/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as hasher from '../security/hash.js';
import { nanoid } from 'nanoid';
import SqliteConnection from './SqliteConnection.js';

export const getUserByUsername = (username) =>
  SqliteConnection.query(
    `SELECT id, username, password, last_login AS lastLogin
     FROM users
     WHERE username = @username
     LIMIT 1`,
    { username },
  )[0] || null;

/**
 * Get a single user by id.
 *
 * @param {string} id - User id (primary key).
 * @returns {User|null} The user when found; otherwise null. The password field is included but callers should not expose it.
 */
export const getUser = (id) => {
  const rows = SqliteConnection.query(
    `SELECT u.id, u.username, u.password, u.last_login AS lastLogin, u.is_admin AS isAdmin,
            (SELECT COUNT(1) FROM jobs j WHERE j.user_id = u.id) AS numberOfJobs
       FROM users u
      WHERE u.id = @id
      LIMIT 1`,
    { id },
  );
  const u = rows[0];
  if (!u) return null;
  return { ...u, isAdmin: !!u.isAdmin };
};

/**
 * Update the single account. Password is only changed when provided.
 *
 * @param {Object} params
 * @param {string} params.username - Username (must be unique in DB).
 * @param {string} [params.password] - Plain text password to set; if omitted on update, existing hash is preserved.
 * @param {string} params.userId - Existing account id.
 * @param {boolean} params.isAdmin - Whether the user should have admin privileges.
 * @returns {void}
 */
export const upsertUser = ({ username, password, userId, isAdmin }) => {
  const id = userId;
  if (!id || SqliteConnection.query(`SELECT 1 FROM users WHERE id = @id LIMIT 1`, { id }).length === 0) {
    throw new Error('Account not found');
  }
  if (password && password.length > 0) {
    SqliteConnection.execute(
      `UPDATE users SET username = @username, password = @password, is_admin = @is_admin WHERE id = @id`,
      { id, username, password: hasher.hash(password), is_admin: isAdmin ? 1 : 0 },
    );
  } else {
    SqliteConnection.execute(`UPDATE users SET username = @username, is_admin = @is_admin WHERE id = @id`, {
      id,
      username,
      is_admin: isAdmin ? 1 : 0,
    });
  }
};

/**
 * Update the last_login timestamp to now for the given user.
 *
 * @param {{userId: string}} params - Parameters.
 * @param {string} params.userId - The user's id.
 * @returns {void}
 */
export const setLastLoginToNow = ({ userId }) => {
  SqliteConnection.execute(`UPDATE users SET last_login = @now WHERE id = @id`, { id: userId, now: Date.now() });
};

/**
 * Ensure there is at least one administrator in the system.
 *
 * Behavior:
 * - If there are no users at all, create default 'admin' user with password 'admin'.
 * - If users exist but none is admin, promote the first existing user to admin.
 *
 * Security: On a fresh instance, a default admin/admin is created; change this password immediately.
 * @returns {void}
 */
export const ensureAdminUserExists = () => {
  const anyUser = SqliteConnection.query(`SELECT id FROM users LIMIT 1`).length > 0;
  if (!anyUser) {
    SqliteConnection.execute(
      `INSERT INTO users (id, username, password, last_login, is_admin)
       VALUES (@id, 'admin', @password, @last_login, 1)`,
      { id: nanoid(), password: hasher.hash('admin'), last_login: Date.now() },
    );
    return;
  }
  const adminCount = SqliteConnection.query(`SELECT COUNT(1) AS c FROM users WHERE is_admin = 1`)[0]?.c ?? 0;
  if (adminCount === 0) {
    const firstUser = SqliteConnection.query(`SELECT id FROM users LIMIT 1`)[0];
    if (firstUser) {
      SqliteConnection.execute(`UPDATE users SET is_admin = 1 WHERE id = @id`, { id: firstUser.id });
    }
  }
};
