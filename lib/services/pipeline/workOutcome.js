/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { classifyProviderError, providerErrorPayload, ProviderTransientError } from './providerErrors.js';

export const WORK_STATUSES = Object.freeze(['pending', 'processing', 'retry', 'deferred', 'done', 'dead', 'cancelled']);

export const WORK_OUTCOMES = Object.freeze([
  'completed',
  'inactive',
  'sent',
  'waiting_model',
  'duplicate',
  'superseded',
  'merged',
  'filtered',
  'failed',
  'abandoned',
  'cancelled',
]);

export const OUTCOME_CODES = Object.freeze([
  'provider_inactive',
  'provider_permanent',
  'challenge',
  'rate_limit',
  'timeout',
  'transient',
  'no_evidence',
  'attempts_exhausted',
  'parked_out',
  'lease_expired',
  'proxy_missing',
  'provider_paused',
  'llm_budget',
  'geocode_unavailable',
  'no_interested_job',
  'provider_removed',
  'already_decided',
  'superseded',
  'merged_duplicate',
  'merged_into_rejected',
  'llm_unextractable',
  'no_market_model',
  'filtered',
  'captured',
  'parsed',
  'rated',
  'delivered',
  'maintained',
  'trained',
  'listing_gone',
  'listing_not_accepted',
  'listing_hidden',
  'job_disabled',
  'adapter_removed',
]);

const STATUS_SET = new Set(WORK_STATUSES);
const OUTCOME_SET = new Set(WORK_OUTCOMES);
const CODE_SET = new Set(OUTCOME_CODES);

function outcome(fields) {
  const value = {
    cause: 'error',
    disposition: 'retry',
    code: 'transient',
    outcome: null,
    note: null,
    error: null,
    severity: 'warn',
    delayMs: null,
    untilMs: null,
    counter: null,
    patch: null,
    classification: null,
    providerSignal: null,
    ...fields,
  };
  if (!CODE_SET.has(value.code)) {
    throw new TypeError(`Unknown work outcome code '${value.code}'. Add it to OUTCOME_CODES deliberately.`);
  }
  if (value.outcome != null && !OUTCOME_SET.has(value.outcome)) {
    throw new TypeError(`Unknown work outcome '${value.outcome}'.`);
  }
  return Object.freeze(value);
}

export function retryOutcome(
  error,
  { code = 'transient', delayMs = null, counter = null, classification = null } = {},
) {
  return outcome({ cause: 'error', disposition: 'retry', code, error, delayMs, counter, classification });
}

export function parkOutcome(code, note, untilMs, { counter = null, providerSignal = null } = {}) {
  return outcome({
    cause: 'policy',
    disposition: 'park',
    code,
    note,
    untilMs,
    counter,
    providerSignal,
    severity: 'info',
  });
}

export function abandonOutcome(code, note, { error = null, classification = null } = {}) {
  return outcome({
    cause: error ? 'error' : 'policy',
    disposition: 'abandon',
    code,
    note,
    error,
    classification,
    outcome: error ? 'failed' : 'abandoned',
    severity: 'error',
  });
}

export function settleOutcome(result, { code = 'completed', note = null, patch = null, severity = 'info' } = {}) {
  return outcome({
    cause: 'success',
    disposition: 'settle',
    code,
    outcome: result,
    note,
    patch,
    severity,
  });
}

export function cancelOutcome(code, note) {
  return outcome({ cause: 'policy', disposition: 'cancel', code, note, outcome: 'cancelled', severity: 'info' });
}

export function filterOutcome() {
  return outcome({ cause: 'filter', disposition: 'cancel', code: 'filtered', outcome: 'filtered', severity: 'info' });
}

const BY_KIND = {
  inactive: (classified) =>
    settleOutcome('inactive', { code: 'provider_inactive', note: classified.message, severity: 'info' }),
  challenge: (classified, { provider, now, parks }) =>
    parkOutcome('challenge', classified.message, now + challengeBackoffMs(parks), {
      providerSignal: provider ? { provider, scope: 'item', signal: 'challenge' } : null,
    }),
  rate_limit: (classified, { now, parks }) =>
    parkOutcome('rate_limit', classified.message, now + (classified.retryAfterMs ?? challengeBackoffMs(parks))),
  timeout: (classified) => retryOutcome(classified, { code: 'timeout' }),
  transient: (classified) => retryOutcome(classified, { code: 'transient' }),
  permanent: (classified) =>
    abandonOutcome('provider_permanent', classified.message, {
      error: classified,
      classification: providerErrorPayload(classified),
    }),
};

function challengeBackoffMs(parks) {
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.min(Number(parks) || 0, 6));
}

export function classifyWorkFailure(spec, item, error, { now = Date.now() } = {}) {
  const classified = classifyProviderError(error) ?? new ProviderTransientError(String(error));
  const custom = spec?.classify?.(item, classified, error);
  if (custom) return custom;
  const build = BY_KIND[classified.kind] ?? BY_KIND.transient;
  return build(classified, {
    provider: item?.payload?.provider ?? null,
    parks: Number(item?.defer_count || 0),
    now,
  });
}

export { STATUS_SET, OUTCOME_SET, CODE_SET };
