/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { env } from '../../shared/env.js';
import logger from '../logger.js';
import { sha256 } from '../../shared/hash.js';

export const EXTRACTION_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const PAUSE_KEY = 'llm_service_pause';

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

// A reservation is taken before the request so parallel callers cannot overshoot
// the cap together, and given back when the request produced no answer. A budget
// is a cap on what the model was asked to do, not on how often its provider was
// unreachable: charging capacity errors and timeouts let a bad afternoon at the
// provider eat a whole day of extraction and park the queue behind it.
export function refundLlmCall(now = Date.now()) {
  SqliteConnection.execute(`UPDATE llm_budget_usage SET count = MAX(0, count - 1) WHERE day = @day AND count > 0`, {
    day: utcDayStart(now),
  });
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

// Configuration errors remain paused across restarts until the API key or model changes.
function configurationFingerprint() {
  return sha256(`${EXTRACTION_MODEL}:${process.env.OPENROUTER_API_KEY || ''}`);
}

function serviceState() {
  const value = SqliteConnection.getConnection()
    .prepare('SELECT value FROM pipeline_control WHERE name = ?')
    .get(PAUSE_KEY)?.value;
  if (!value) return { failures: 0, until: 0 };
  const state = JSON.parse(value);
  return state.fingerprint === configurationFingerprint() ? state : { failures: 0, until: 0 };
}

export function canExtract(now = Date.now()) {
  if (!process.env.OPENROUTER_API_KEY) {
    return { ok: false, reason: 'OPENROUTER_API_KEY is required', retryAtMs: now + 60_000 };
  }
  const state = serviceState();
  if (state.until > now) {
    return { ok: false, retryAtMs: state.until, reason: state.reason };
  }
  return canSpend(now);
}

export function assertExtractionAvailable(now = Date.now()) {
  const verdict = canExtract(now);
  if (!verdict.ok) throw new LlmBudgetExhaustedError(verdict.reason, verdict.retryAtMs);
}

export function pauseExtraction(outcome, { retryAtMs = null, permanent = false, now = Date.now() } = {}) {
  const failures = Number(serviceState().failures || 0) + 1;
  const delayMs = Math.min(
    env('FREDY_LLM_UPSTREAM_MAX_BACKOFF_MS'),
    env('FREDY_LLM_UPSTREAM_BACKOFF_MS') * 2 ** Math.min(failures - 1, 10),
  );
  const until = permanent ? 8640000000000000 : Math.max(now + delayMs, retryAtMs ?? 0);
  const reason = permanent
    ? `OpenRouter configuration failure (${outcome}); correct credentials/configuration before resuming`
    : `OpenRouter temporarily paused (${outcome})`;
  SqliteConnection.getConnection()
    .prepare(
      `INSERT INTO pipeline_control (name, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(PAUSE_KEY, JSON.stringify({ fingerprint: configurationFingerprint(), failures, until, reason }), now);
  logger.event('llm_service_paused', 'warn', { outcome, failures, until, permanent });
  return until;
}

export function clearExtractionPause() {
  SqliteConnection.getConnection().prepare('DELETE FROM pipeline_control WHERE name = ?').run(PAUSE_KEY);
}
