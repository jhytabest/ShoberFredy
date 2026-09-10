/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { env } from '../../shared/env.js';
import logger from '../logger.js';

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

export function configuredLlmModels() {
  const fallback =
    process.env.FREDY_LLM_FALLBACK_MODELS != null
      ? process.env.FREDY_LLM_FALLBACK_MODELS
      : env('FREDY_LLM_FALLBACK_MODEL') || env('FREDY_LLM_FALLBACK_MODELS');
  const models = [
    ...new Set(
      [env('FREDY_LLM_TEXT_MODEL') || 'nvidia/nemotron-3-ultra-550b-a55b:free', ...fallback.split(',')]
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
  if (models.length > 3 || models.some((model) => !model.endsWith(':free'))) {
    const error = new Error('Configure at most three explicit :free extraction models');
    error.infrastructureFailure = true;
    throw error;
  }
  return models;
}

function modelState(model) {
  const value = SqliteConnection.getConnection()
    .prepare('SELECT value FROM pipeline_control WHERE name = ?')
    .get(`llm_model_pause:${model}`)?.value;
  try {
    const state = value ? JSON.parse(value) : null;
    return state && Number.isFinite(state.until) && Number.isFinite(state.failures) ? state : { failures: 0, until: 0 };
  } catch {
    return { failures: 0, until: 0 };
  }
}

export function canExtract(now = Date.now()) {
  const budget = canSpend(now);
  if (!budget.ok) return budget;
  const states = configuredLlmModels().map(modelState);
  return states.some((state) => state.until <= now)
    ? { ok: true }
    : {
        ok: false,
        retryAtMs: Math.min(...states.map((state) => state.until)),
        reason: 'All configured LLM models are paused after request failures',
      };
}

export function assertModelAvailable(model, now = Date.now()) {
  const state = modelState(model);
  if (state.until <= now) return;
  const error = new Error(`LLM model '${model}' is paused after request failures`);
  error.infrastructureFailure = true;
  error.fallbackEligible = true;
  error.retryAtMs = state.until;
  throw error;
}

export function pauseModel(model, outcome, now = Date.now(), retryAtMs = null) {
  const previous = modelState(model);
  const failures = Number(previous.failures || 0) + 1;
  const delayMs = Math.min(
    env('FREDY_LLM_UPSTREAM_MAX_BACKOFF_MS'),
    env('FREDY_LLM_UPSTREAM_BACKOFF_MS') * 2 ** Math.min(failures - 1, 10),
  );
  const until = Math.max(now + delayMs, retryAtMs ?? 0);
  SqliteConnection.getConnection()
    .prepare(
      `INSERT INTO pipeline_control (name, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(`llm_model_pause:${model}`, JSON.stringify({ failures, until, outcome }), now);
  logger.event('llm_model_paused', 'warn', { model, outcome, failures, until });
  return until;
}

export function clearModelPause(model) {
  const result = SqliteConnection.getConnection()
    .prepare('DELETE FROM pipeline_control WHERE name = ?')
    .run(`llm_model_pause:${model}`);
  if (result.changes) logger.event('llm_model_recovered', 'info', { model });
}
