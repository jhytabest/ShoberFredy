/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import logger from '../logger.js';
import { env } from '../../shared/env.js';
import { tableExists } from '../../shared/sqlite.js';

/*
 * How much a provider is currently refusing to talk to us, and what to do about
 * it.
 *
 * A provider that is blocked or whose markup has changed fails identically for
 * every job, but the scheduler used to discover that once per job: three jobs
 * meant three full navigations, three deadline waits and three browser-session
 * resets every hour, all to learn the same fact. Pausing the provider is what
 * stops paying full price while it is down.
 *
 * Three things were wrong with how that pause was decided.
 *
 * It could not tell one challenged advert from a blocked IP. A bot challenge on
 * a single detail page is ordinary scraping — portals challenge a fraction of
 * requests and a fresh session usually clears it — but it was counted at the
 * same weight as a discovery run that returned nothing, and the threshold is
 * two. So two challenged adverts paused an entire provider for thirty minutes,
 * escalating to six hours. wgGesucht, which is 46% of discovery, was repeatedly
 * paused this way. Item-scope challenges now accumulate on their own score at
 * their own much higher threshold, and never open the breaker on their own.
 *
 * The counter never came down. Only a success reset it, success was only ever
 * recorded from discovery, and the detail path had no way to report one at all —
 * so a provider answering detail pages perfectly could still be climbing toward
 * a six-hour pause. Scores now decay continuously, computed on read from the
 * time since the last signal, and a successful capture is itself a signal.
 *
 * It was in memory. Every restart forgot every pause and every accumulated
 * failure, so a provider that had earned a six-hour cooldown got a clean slate
 * from a deploy. The state is a table now, which also makes "why is nothing
 * being fetched from immowelt" answerable after the fact.
 */

/** Signals that say something about the provider rather than about one advert. */
const SYSTEMIC = new Set(['challenge', 'error', 'timeout', 'empty']);

/**
 * A discovery run returning nothing is weaker evidence than one being refused:
 * an empty search page is equally consistent with a changed selector, or with
 * nobody having listed a flat in that polygon this hour.
 */
const SIGNAL_WEIGHT = { challenge: 1, error: 1, timeout: 1, empty: 0.5 };

/** Score halves over this long, so an old failure stops counting on its own. */
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

function read(providerId, now) {
  const row = db().prepare(`SELECT * FROM provider_breaker_state WHERE provider = ?`).get(providerId);
  if (!row) return { failureScore: 0, challengeScore: 0, openUntil: 0, lastSuccessAt: null, lastSignalAt: now };
  return {
    failureScore: decayed(row.failure_score, row.last_signal_at, now),
    challengeScore: decayed(row.challenge_score, row.last_signal_at, now),
    openUntil: Number(row.open_until || 0),
    lastSuccessAt: row.last_success_at,
    lastSignalAt: Number(row.last_signal_at || now),
  };
}

function write(providerId, state, now) {
  db()
    .prepare(
      `INSERT INTO provider_breaker_state
         (provider, failure_score, challenge_score, open_until, last_success_at, last_signal_at, updated_at)
       VALUES (@provider, @failureScore, @challengeScore, @openUntil, @lastSuccessAt, @now, @now)
       ON CONFLICT(provider) DO UPDATE SET
         failure_score = excluded.failure_score,
         challenge_score = excluded.challenge_score,
         open_until = excluded.open_until,
         last_success_at = excluded.last_success_at,
         last_signal_at = excluded.last_signal_at,
         updated_at = excluded.updated_at`,
    )
    .run({ provider: providerId, ...state, now });
}

/**
 * Report one thing that happened with a provider.
 *
 * @param {{provider: string, scope: 'item'|'discovery', signal: 'ok'|'challenge'|'error'|'timeout'|'empty'}} event
 * @param {number} [now]
 * @returns {void}
 */
export function recordProviderSignal({ provider, scope, signal }, now = Date.now()) {
  if (!provider || !ready()) return;
  const state = read(provider, now);

  if (signal === 'ok') {
    // A success is evidence in both directions and it decays nothing else away:
    // it clears the pause outright. Reported from discovery and, now, from every
    // completed detail capture.
    if (state.failureScore >= 1 || state.openUntil > now) {
      logger.info(`Provider '${provider}' is answering again; clearing its pause.`);
    }
    write(provider, { failureScore: 0, challengeScore: 0, openUntil: 0, lastSuccessAt: now }, now);
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
      `Pausing '${provider}' for ${Math.round(cooldown / 60000)} min: ` +
        (challengedOut
          ? `${Math.round(challengeScore)} challenged requests with no success in between.`
          : `discovery ${signal}.`),
    );
  }
  write(provider, { failureScore, challengeScore, openUntil, lastSuccessAt: state.lastSuccessAt }, now);
}

/**
 * @param {string} providerId
 * @param {number} [now]
 * @returns {boolean}
 */
export function isProviderPaused(providerId, now = Date.now()) {
  if (!ready()) return false;
  return read(providerId, now).openUntil > now;
}

/**
 * @param {string} providerId
 * @param {number} [now]
 * @returns {number} milliseconds remaining, 0 when not paused
 */
export function pausedForMs(providerId, now = Date.now()) {
  if (!ready()) return 0;
  return Math.max(0, read(providerId, now).openUntil - now);
}

/**
 * Per-provider state for the health endpoint and the exporter.
 *
 * A provider that stops answering is the failure this system is least able to
 * notice on its own: the breaker backs off, the queue drains, every worker keeps
 * beating, and the health endpoint says ok while a quarter of the market goes
 * unseen. Immowelt did exactly that for eleven hours. The age of the last
 * successful discovery is the number that would have said so out loud.
 *
 * @param {number} [now]
 * @returns {{provider: string, pausedForMs: number, failures: number, challenges: number,
 *            lastSuccessAgeMs: number|null}[]}
 */
export function providerDiscoveryHealth(now = Date.now()) {
  if (!ready()) return [];
  return db()
    .prepare(`SELECT * FROM provider_breaker_state ORDER BY provider`)
    .all()
    .map((row) => ({
      provider: row.provider,
      pausedForMs: Math.max(0, Number(row.open_until || 0) - now),
      failures: decayed(row.failure_score, row.last_signal_at, now),
      challenges: decayed(row.challenge_score, row.last_signal_at, now),
      lastSuccessAgeMs: row.last_success_at ? now - Number(row.last_success_at) : null,
    }));
}

/** The claim predicate that keeps paused providers out of the queue entirely. */
export function pausedProviderClaimFilter(now = Date.now()) {
  if (!ready()) return null;
  return {
    sql: `AND COALESCE(json_extract(w.payload_json, '$.provider'), '') NOT IN
            (SELECT provider FROM provider_breaker_state WHERE open_until > @breakerNow)`,
    params: { breakerNow: now },
  };
}
