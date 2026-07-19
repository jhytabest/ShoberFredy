/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Central, persistent LLM request budget.
 *
 * Every OpenRouter request (vision or text) consumes exactly one unit of the
 * shared daily budget (`FREDY_LLM_DAILY_LIMIT`, default 1000 — the OpenRouter
 * free-tier allowance). Live parsing may consume the whole budget; backfill
 * is capped at `FREDY_LLM_BACKFILL_SHARE` (default 0.8) of it, leaving a
 * protected share for live listings. Usage is persisted
 * per UTC day in `llm_budget_usage`, so restarts never lose track.
 *
 * The budget is a queue pacing mechanism, never a failure mode: when it is
 * exhausted (locally, or upstream via a 429) callers receive an
 * {@link LlmBudgetExhaustedError} carrying the timestamp at which to try
 * again, and queue items simply wait until then.
 */

import SqliteConnection from '../storage/SqliteConnection.js';

const BLOCK_CONTROL_KEY = 'llm_blocked_until';
/** Safety margin added to reset timestamps so we never retry a second early. */
const RESET_MARGIN_MS = 2 * 60 * 1000;

export class LlmBudgetExhaustedError extends Error {
  /**
   * @param {string} message human-readable reason
   * @param {number} retryAtMs epoch ms at which the budget is expected back
   */
  constructor(message, retryAtMs) {
    super(message);
    this.name = 'LlmBudgetExhaustedError';
    this.retryAtMs = retryAtMs;
  }
}

/** @returns {number} configured daily request limit */
export function dailyLimit() {
  return positiveEnv('FREDY_LLM_DAILY_LIMIT', 1000);
}

/** @returns {number} share of the daily limit backfill may consume (0..1) */
export function backfillShare() {
  const parsed = Number.parseFloat(process.env.FREDY_LLM_BACKFILL_SHARE || '');
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.8;
}

/**
 * Check whether one LLM request of the given kind could be reserved right
 * now, without reserving it. Used by the queue to avoid claiming items it
 * cannot serve yet.
 *
 * @param {'live'|'backfill'} kind
 * @param {number} [now]
 * @returns {{ok: true} | {ok: false, retryAtMs: number, reason: string}}
 */
export function canSpend(kind, now = Date.now()) {
  return evaluate(kind, now);
}

/**
 * Reserve one LLM request of the given kind, or throw
 * {@link LlmBudgetExhaustedError} with the retry timestamp. Reservation and
 * the availability check run in one transaction, so the counter is exact.
 *
 * @param {'live'|'backfill'} kind
 * @param {number} [now]
 */
export function reserveLlmCall(kind, now = Date.now()) {
  const db = SqliteConnection.getConnection();
  db.transaction(() => {
    const verdict = evaluate(kind, now);
    if (!verdict.ok) throw new LlmBudgetExhaustedError(verdict.reason, verdict.retryAtMs);
    db.prepare(
      `INSERT INTO llm_budget_usage (day, kind, count) VALUES (?, ?, 1)
       ON CONFLICT(day, kind) DO UPDATE SET count = count + 1`,
    ).run(utcDayStart(now), kind);
  })();
}

/**
 * Record an upstream rate-limit response (HTTP 429). All LLM work waits
 * until the provider-reported reset; without one, until the next UTC day.
 *
 * @param {number|null} resetAtMs provider-reported reset epoch ms, if any
 * @param {number} [now]
 * @returns {number} the effective epoch ms until which LLM calls are blocked
 */
export function noteUpstreamExhausted(resetAtMs, now = Date.now()) {
  const fallback = nextUtcDayStart(now);
  const until = clampReset(resetAtMs, now) ?? fallback;
  SqliteConnection.execute(
    `INSERT INTO pipeline_control (name, value, updated_at) VALUES (@name, @value, @now)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { name: BLOCK_CONTROL_KEY, value: String(until), now },
  );
  return until;
}

/**
 * Current budget usage, for the status CLI and the metrics exporter.
 *
 * @param {number} [now]
 * @returns {{day: number, limit: number, backfillLimit: number, used: {live: number, backfill: number},
 *   blockedUntil: number|null}}
 */
export function budgetStatus(now = Date.now()) {
  const db = SqliteConnection.getConnection();
  const rows = db.prepare('SELECT kind, count FROM llm_budget_usage WHERE day = ?').all(utcDayStart(now));
  const used = { live: 0, backfill: 0 };
  for (const row of rows) used[row.kind] = row.count;
  const blockedUntil = readBlockedUntil(db);
  return {
    day: utcDayStart(now),
    limit: dailyLimit(),
    backfillLimit: Math.floor(dailyLimit() * backfillShare()),
    used,
    blockedUntil: blockedUntil > now ? blockedUntil : null,
  };
}

function evaluate(kind, now) {
  const db = SqliteConnection.getConnection();
  const blockedUntil = readBlockedUntil(db);
  if (blockedUntil > now) {
    return { ok: false, retryAtMs: blockedUntil, reason: 'Upstream LLM rate limit active' };
  }
  const day = utcDayStart(now);
  const rows = db.prepare('SELECT kind, count FROM llm_budget_usage WHERE day = ?').all(day);
  const used = { live: 0, backfill: 0 };
  for (const row of rows) used[row.kind] = row.count;
  const total = used.live + used.backfill;
  const retryAtMs = nextUtcDayStart(now);
  if (total >= dailyLimit()) {
    return { ok: false, retryAtMs, reason: `Daily LLM budget of ${dailyLimit()} requests exhausted` };
  }
  if (kind === 'backfill' && used.backfill >= Math.floor(dailyLimit() * backfillShare())) {
    return { ok: false, retryAtMs, reason: `Backfill share of the daily LLM budget exhausted` };
  }
  return { ok: true };
}

function readBlockedUntil(db) {
  const value = db.prepare('SELECT value FROM pipeline_control WHERE name = ?').get(BLOCK_CONTROL_KEY)?.value;
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampReset(resetAtMs, now) {
  if (!Number.isFinite(resetAtMs) || resetAtMs == null) return null;
  // Never trust a reset further out than a bit past the next UTC day.
  const cap = nextUtcDayStart(now) + RESET_MARGIN_MS;
  return Math.min(Math.max(resetAtMs + RESET_MARGIN_MS, now + 1000), cap);
}

function utcDayStart(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function nextUtcDayStart(now) {
  return utcDayStart(now) + 24 * 60 * 60 * 1000 + RESET_MARGIN_MS;
}

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
