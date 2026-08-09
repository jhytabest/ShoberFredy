/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import logger from '../logger.js';
import { env } from '../../shared/env.js';
import { tableExists } from '../../shared/sqlite.js';

const SYSTEMIC = new Set(['challenge', 'error', 'timeout', 'empty']);

const SIGNAL_WEIGHT = { challenge: 1, error: 1, timeout: 1, empty: 0.5 };

const DECAY_HALF_LIFE_MS = 60 * 60 * 1000;

function db() {
  return SqliteConnection.getConnection();
}

function ready() {
  return tableExists(db(), 'provider_breaker_state');
}

function decayed(score, lastSignalAt, now) {
  const elapsed = Math.max(0, now - Number(lastSignalAt || now));
  return Number(score || 0) * 0.5 ** (elapsed / DECAY_HALF_LIFE_MS);
}

function read(providerId, market, now) {
  const row = db()
    .prepare(`SELECT * FROM provider_breaker_state WHERE provider = ? AND market = ?`)
    .get(providerId, market);
  if (!row) return { failureScore: 0, challengeScore: 0, openUntil: 0, lastSuccessAt: null, lastSignalAt: now };
  return {
    failureScore: decayed(row.failure_score, row.last_signal_at, now),
    challengeScore: decayed(row.challenge_score, row.last_signal_at, now),
    openUntil: Number(row.open_until || 0),
    lastSuccessAt: row.last_success_at,
    lastSignalAt: Number(row.last_signal_at || now),
  };
}

function write(providerId, market, state, now) {
  db()
    .prepare(
      `INSERT INTO provider_breaker_state
         (provider, market, failure_score, challenge_score, open_until, last_success_at, last_signal_at, updated_at)
       VALUES (@provider, @market, @failureScore, @challengeScore, @openUntil, @lastSuccessAt, @now, @now)
       ON CONFLICT(provider, market) DO UPDATE SET
         failure_score = excluded.failure_score,
         challenge_score = excluded.challenge_score,
         open_until = excluded.open_until,
         last_success_at = excluded.last_success_at,
         last_signal_at = excluded.last_signal_at,
         updated_at = excluded.updated_at`,
    )
    .run({ provider: providerId, market, ...state, now });
}

// A provider being blocked on one city's search says nothing about another
// city's — "Nothing about one search is stored where another search would
// read it" applies to the breaker too. A signal with no market to attribute
// it to (no job or listing anchors it) is dropped rather than guessed at.
export function recordProviderSignal({ provider, market, scope, signal }, now = Date.now()) {
  if (!provider || !market || !ready()) return;
  const state = read(provider, market, now);

  if (signal === 'ok') {
    // A success only clears the evidence it actually contradicts. Detail
    // captures and liveness probes report scope 'item', and one of those
    // succeeding says nothing about whether discovery is still returning
    // results — letting it zero the discovery score meant a provider could
    // return empty search pages indefinitely without the breaker ever moving,
    // as long as any queued item kept draining.
    const clearsDiscovery = scope === 'discovery';
    if (clearsDiscovery && (state.failureScore >= 1 || state.openUntil > now)) {
      logger.info(`Provider '${provider}' is answering again; clearing its pause.`);
    }
    write(
      provider,
      market,
      {
        failureScore: clearsDiscovery ? 0 : state.failureScore,
        challengeScore: 0,
        openUntil: clearsDiscovery ? 0 : state.openUntil,
        lastSuccessAt: now,
      },
      now,
    );
    return;
  }

  const systemic = scope === 'discovery' && SYSTEMIC.has(signal);
  const failureScore = state.failureScore + (systemic ? (SIGNAL_WEIGHT[signal] ?? 1) : 0);
  const challengeScore = state.challengeScore + (systemic ? 0 : 1);

  const failureLimit = env('FREDY_PROVIDER_BREAKER_FAILURES');
  const challengeLimit = env('FREDY_PROVIDER_BREAKER_ITEM_CHALLENGES');
  const over = failureScore >= failureLimit ? failureScore - failureLimit : null;
  const challengedOut = challengeScore >= challengeLimit;

  let openUntil = state.openUntil;
  if (over != null || challengedOut) {
    const steps = over != null ? over : 0;
    const cooldown = Math.min(
      env('FREDY_PROVIDER_BREAKER_MAX_COOLDOWN_MS'),
      env('FREDY_PROVIDER_BREAKER_COOLDOWN_MS') * 2 ** steps,
    );
    openUntil = Math.max(openUntil, now + cooldown);
    logger.warn(
      `Pausing '${provider}' in market '${market}' for ${Math.round(cooldown / 60000)} min: ` +
        (challengedOut
          ? `${Math.round(challengeScore)} challenged requests with no success in between.`
          : `discovery ${signal}.`),
    );
  }
  write(provider, market, { failureScore, challengeScore, openUntil, lastSuccessAt: state.lastSuccessAt }, now);
}

export function isProviderPaused(providerId, market, now = Date.now()) {
  if (!ready()) return false;
  return read(providerId, market, now).openUntil > now;
}

export function pausedForMs(providerId, market, now = Date.now()) {
  if (!ready()) return 0;
  return Math.max(0, read(providerId, market, now).openUntil - now);
}

export function providerDiscoveryHealth(now = Date.now()) {
  if (!ready()) return [];
  return db()
    .prepare(`SELECT * FROM provider_breaker_state ORDER BY provider, market`)
    .all()
    .map((row) => ({
      provider: row.provider,
      market: row.market,
      pausedForMs: Math.max(0, Number(row.open_until || 0) - now),
      failures: decayed(row.failure_score, row.last_signal_at, now),
      challenges: decayed(row.challenge_score, row.last_signal_at, now),
      lastSuccessAgeMs: row.last_success_at ? now - Number(row.last_success_at) : null,
    }));
}

export function pausedProviderClaimFilter(now = Date.now()) {
  if (!ready()) return null;
  return {
    sql: `AND COALESCE(json_extract(w.payload_json, '$.provider'), '') NOT IN
            (SELECT provider FROM provider_breaker_state WHERE open_until > @breakerNow)`,
    params: { breakerNow: now },
  };
}
