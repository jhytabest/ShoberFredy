/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { env } from '../../shared/env.js';

const BLOCK_CONTROL_KEY = 'llm_blocked_until';
const RESET_MARGIN_MS = 2 * 60 * 1000;

export class LlmBudgetExhaustedError extends Error {
  constructor(message, retryAtMs) {
    super(message);
    this.name = 'LlmBudgetExhaustedError';
    this.retryAtMs = retryAtMs;
  }
}

export function canSpend(now = Date.now()) {
  return evaluate(now);
}

export function reserveLlmCall(now = Date.now()) {
  const db = SqliteConnection.getConnection();
  db.transaction(() => {
    const verdict = evaluate(now);
    if (!verdict.ok) throw new LlmBudgetExhaustedError(verdict.reason, verdict.retryAtMs);
    db.prepare(
      `INSERT INTO llm_budget_usage (day, count) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET count = count + 1`,
    ).run(utcDayStart(now));
  })();
}

// `fromUpstream` marks a reset timestamp the provider gave us, which is worth
// overshooting slightly — clocks differ and a request landing one second early
// is refused again. A backoff we chose ourselves is already the delay we want,
// so adding the margin to it just silently triples the pause.
export function noteUpstreamExhausted(resetAtMs, { fromUpstream = false, now = Date.now() } = {}) {
  const until = clampReset(resetAtMs, now, fromUpstream) ?? nextUtcDayStart(now);
  SqliteConnection.execute(
    `INSERT INTO pipeline_control (name, value, updated_at) VALUES (@name, @value, @now)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { name: BLOCK_CONTROL_KEY, value: String(until), now },
  );
  return until;
}

export function budgetStatus(now = Date.now()) {
  const db = SqliteConnection.getConnection();
  const used = db.prepare('SELECT count FROM llm_budget_usage WHERE day = ?').get(utcDayStart(now))?.count || 0;
  const blockedUntil = readBlockedUntil(db);
  return {
    day: utcDayStart(now),
    limit: dailyLimit(),
    used,
    blockedUntil: blockedUntil > now ? blockedUntil : null,
  };
}

function evaluate(now) {
  const db = SqliteConnection.getConnection();
  const blockedUntil = readBlockedUntil(db);
  if (blockedUntil > now) {
    return { ok: false, retryAtMs: blockedUntil, reason: 'Upstream LLM rate limit active' };
  }
  const used = db.prepare('SELECT count FROM llm_budget_usage WHERE day = ?').get(utcDayStart(now))?.count || 0;
  if (used >= dailyLimit()) {
    return {
      ok: false,
      retryAtMs: nextUtcDayStart(now),
      reason: `Daily LLM budget of ${dailyLimit()} requests exhausted`,
    };
  }
  return { ok: true };
}

function dailyLimit() {
  return env('FREDY_LLM_DAILY_LIMIT');
}

function readBlockedUntil(db) {
  const value = db.prepare('SELECT value FROM pipeline_control WHERE name = ?').get(BLOCK_CONTROL_KEY)?.value;
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampReset(resetAtMs, now, fromUpstream) {
  if (!Number.isFinite(resetAtMs) || resetAtMs == null) return null;
  const target = fromUpstream ? resetAtMs + RESET_MARGIN_MS : resetAtMs;
  return Math.min(Math.max(target, now + 1000), now + 26 * 60 * 60 * 1000);
}

function utcDayStart(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function nextUtcDayStart(now) {
  return utcDayStart(now) + 24 * 60 * 60 * 1000 + RESET_MARGIN_MS;
}
