/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from './SqliteConnection.js';
import { DEFAULT_FILTERS, filterProblems } from '../pipeline/listingFilters.js';
import { redact } from '../logger.js';

export function getPipelineConfig(db = SqliteConnection.getConnection()) {
  const row = db.prepare('SELECT * FROM pipeline_config WHERE id = 1').get();
  if (!row) throw new Error('Shared pipeline configuration is missing');
  return { filters: { ...DEFAULT_FILTERS, ...JSON.parse(row.filters_json) }, notify: JSON.parse(row.notify_json), cutoverAt: row.cutover_at };
}

export function patchPipelineConfig(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some((key) => !['filters', 'notify'].includes(key)))
    throw new TypeError('Pipeline patch accepts only filters and notify objects');
  for (const key of ['filters', 'notify']) if (key in patch && (!patch[key] || typeof patch[key] !== 'object' || Array.isArray(patch[key])))
    throw new TypeError(`${key} must be an object`);
  return SqliteConnection.withTransaction((db) => {
    const current = getPipelineConfig(db);
    const next = { filters: { ...DEFAULT_FILTERS, ...current.filters, ...patch.filters }, notify: { ...current.notify, ...patch.notify } };
    const problems = [...filterProblems(next.filters), ...notifyProblems(next.notify)];
    if (problems.length) throw new TypeError(problems.join('; '));
    db.prepare('UPDATE pipeline_config SET filters_json = ?, notify_json = ? WHERE id = 1').run(JSON.stringify(next.filters), JSON.stringify(next.notify));
    db.prepare("UPDATE listing_decisions SET config_hash=''").run();
    return redact({ ...next, cutoverAt: current.cutoverAt });
  });
}

export function notifyProblems(notify) {
  if (!notify || typeof notify !== 'object' || Array.isArray(notify)) return ['notify must be an object'];
  const problems = [];
  for (const key of Object.keys(notify)) if (!['token', 'chatId', 'threadId', 'plainText'].includes(key)) problems.push(`Unknown notify field '${key}'`);
  if (typeof notify.token !== 'string' || !notify.token.trim()) problems.push('notify.token is required');
  const chats = String(notify.chatId ?? '').split(',').map((s) => s.trim());
  if (!chats.length || chats.some((s) => !/^-?\d+$/.test(s))) problems.push('notify.chatId must contain numeric Telegram chat IDs');
  if (notify.threadId != null && (!Number.isInteger(Number(notify.threadId)) || Number(notify.threadId) <= 0)) problems.push('notify.threadId must be positive or null');
  if (notify.plainText != null && typeof notify.plainText !== 'boolean') problems.push('notify.plainText must be boolean');
  return problems;
}
