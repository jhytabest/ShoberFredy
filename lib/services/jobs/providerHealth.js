/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import logger from '../logger.js';
import { env } from '../../shared/env.js';
import { hashParts } from '../../shared/hash.js';
import { duringWorkingHoursOrNotSet } from '../../utils.js';
import { tableExists } from '../../shared/sqlite.js';

// A challenge is not evidence that discovery is broken — it is the portal saying
// no to this request, which is a normal answer and now costs about two seconds to
// receive. Backing off for half an hour over one turns an expected refusal into an
// outage: the pause outlives several scheduled runs, and the portal was never going
// to stay angry that long. So a blocked run is logged, counted and moved on from,
// and the job's own interval is the retry. Timeouts and errors still accumulate,
// because those say something is wrong at our end or on the wire.
const SYSTEMIC = new Set(['error', 'transient', 'permanent', 'timeout']);

const SIGNAL_WEIGHT = { error: 1, timeout: 1, empty: 0.5 };

const DECAY_HALF_LIFE_MS = 60 * 60 * 1000;

function db() {
  return SqliteConnection.getConnection();
}

function ready() {
  return tableExists(db(), 'provider_breaker_state');
}

// Halving never reaches zero, so a provider that misbehaved once kept reporting
// a score of 1e-144 days later. Below a hundredth of a signal the breaker treats
// it as nothing anyway, so say nothing rather than printing the dust.
const SCORE_FLOOR = 0.01;

function decayed(score, lastSignalAt, now) {
  const elapsed = Math.max(0, now - Number(lastSignalAt || now));
  const remaining = Number(score || 0) * 0.5 ** (elapsed / DECAY_HALF_LIFE_MS);
  return remaining < SCORE_FLOOR ? 0 : remaining;
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

  if (signal === 'ok' || (scope === 'discovery' && signal === 'empty')) {
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
        lastSuccessAt: clearsDiscovery ? now : state.lastSuccessAt,
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

// Evidence the provider did not produce. A pause is meant to back off a portal
// that is refusing us; when the reason every portal refused us was that our own
// egress had gone, holding a 30-minute pause against them means the cooldown
// outlives every window in which it could be tested. The proxy here is an exit
// node on a laptop, so its recoveries are shorter than one cooldown — without
// this, a provider paused during an outage will never retry while it is up.
export function clearProviderPauses(reason) {
  if (!ready()) return 0;
  const { changes } = db()
    .prepare(
      `UPDATE provider_breaker_state SET failure_score = 0, challenge_score = 0, open_until = 0
              WHERE open_until > 0 OR failure_score > 0`,
    )
    .run();
  if (changes) logger.info(`Cleared discovery pauses for ${changes} provider(s): ${reason}.`);
  return changes;
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

export function recordDiscoveryRun(job, source, outcome, count = null, now = Date.now()) {
  const name = discoveryKey(job.id, source);
  const previous = JSON.parse(
    db().prepare('SELECT value FROM pipeline_control WHERE name = ?').get(name)?.value ?? '{}',
  );
  const success = outcome === 'ok' || outcome === 'empty';
  const value = {
    jobId: job.id,
    provider: source.id,
    outcome,
    count,
    finishedAt: now,
    lastSuccessAt: success ? now : (previous.lastSuccessAt ?? null),
    lastFoundAt: count > 0 ? now : (previous.lastFoundAt ?? null),
  };
  db()
    .prepare(
      `INSERT INTO pipeline_control (name, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(name, JSON.stringify(value), now);
}

export function jobDiscoveryHealth(jobs, now = Date.now()) {
  return jobs.flatMap((job) =>
    job.provider.map((source) => {
      const row = db().prepare('SELECT value FROM pipeline_control WHERE name = ?').get(discoveryKey(job.id, source));
      const value = JSON.parse(row?.value ?? '{}');
      const due = duringWorkingHoursOrNotSet(job, now);
      const stale =
        due && (!value.lastSuccessAt || now - value.lastSuccessAt > Math.max(job.interval * 3 * 60_000, 60 * 60_000));
      return {
        jobId: job.id,
        provider: source.id,
        searchId: hashParts(source.url),
        outcome: value.outcome ?? 'not_run',
        count: value.count ?? null,
        lastRunAgeMs: value.finishedAt ? now - value.finishedAt : null,
        lastSuccessAgeMs: value.lastSuccessAt ? now - value.lastSuccessAt : null,
        lastFoundAgeMs: value.lastFoundAt ? now - value.lastFoundAt : null,
        needsAttention: stale || (due && !['ok', 'empty'].includes(value.outcome)),
      };
    }),
  );
}

function discoveryKey(jobId, source) {
  return `discovery:${hashParts(jobId, source.id, source.url)}`;
}
