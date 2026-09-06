/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { setLogSink } from '../logger.js';

export function attachDatabaseLog(db) {
  const insert = db.prepare(`INSERT INTO runtime_events (severity, event, message, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  setLogSink(({ level, event, args, createdAt }) =>
    insert.run(level, event, args.filter((arg) => typeof arg === 'string').join(' '), JSON.stringify(args), createdAt),
  );
}
