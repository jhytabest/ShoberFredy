/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { storeAuditPayload } from './auditPayloadStorage.js';
import { setLogSink } from '../logger.js';

export function attachDatabaseLog(db) {
  const insert = db.prepare(`INSERT INTO runtime_events (severity, event, message, payload_sha256, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  setLogSink(({ level, event, args, createdAt }) =>
    db.transaction(() => {
      const hash = storeAuditPayload(args, db, createdAt);
      insert.run(
        level,
        event,
        args
          .filter((arg) => typeof arg === 'string')
          .join(' ')
          .slice(0, 2000),
        hash,
        createdAt,
      );
    })(),
  );
}
