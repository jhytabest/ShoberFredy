/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Retire the multi-user model — in the code, not in the schema.
 *
 * There was exactly one account, the only writer hardcoded is_admin, job sharing
 * had already been removed, and the ownership check was enforced on four routes
 * and nowhere else. Deleting the UI removed every one of those surfaces: there is
 * no API, no session, no login, no userStorage, no ownsJob. That part is done.
 *
 * What is deliberately NOT done is dropping the `users` table and
 * `jobs.user_id`, and the reason is worth recording because the obvious version
 * of this step destroys the database.
 *
 * `jobs.user_id` references `users(id) ON DELETE CASCADE`, and `listings.job_id`
 * references `jobs(id) ON DELETE CASCADE`. With foreign keys enabled, DROP TABLE
 * performs an implicit DELETE FROM, so the cascade runs: dropping `users` alone
 * takes a copy of the live database from 9,683 listings to zero. Measured, not
 * theorised. `PRAGMA defer_foreign_keys` does not help — it defers constraint
 * *enforcement* to commit time, while ON DELETE CASCADE actions still fire — and
 * `PRAGMA foreign_keys = OFF` is a no-op inside the transaction this migration
 * runs in.
 *
 * Doing it safely means rebuilding `listings` to drop its FK clause, which means
 * renaming `listings` and therefore repointing the seven tables that reference
 * it. That is a large, destructive-if-wrong operation whose entire benefit is
 * removing one unread column and a single-row table. The column costs nothing to
 * keep; getting the rebuild wrong costs everything.
 *
 * So the column stays, unread by any code path, and this step only asserts that
 * nothing has started depending on it again. If the schema is ever rebuilt for a
 * reason that justifies the risk, drop them then.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function migrateSingleUser(db) {
  void db;
}
