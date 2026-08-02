/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * How work ends. One policy, for every kind.
 *
 * There was a good error taxonomy in providerErrors.js and exactly one of the
 * six workers used it. The others saw every failure as one undifferentiated
 * class, so a withdrawn advert, a bot challenge and a broken selector all took
 * the same path, and each worker had invented its own answer to "retry, wait, or
 * give up" — three ways of abandoning an item, two backoff curves besides the
 * shared one, and three kinds that could never give up at all.
 *
 * Three questions were also being answered in one column. `status` carried both
 * where an item is in its lifecycle and what became of it, so 'sent' and
 * 'retry' were alternatives to each other; `last_error` carried real exception
 * messages, filter reason codes like 'blacklist', policy sentences like "No job
 * is interested in this advert any more", and wait notices prefixed "Waiting:".
 * Nothing could ask how many items were parked on a resource versus failing,
 * because a deferral was stored as a retry.
 *
 * So they are separated:
 *
 *   status        lifecycle only — pending, processing, retry, deferred,
 *                 done, dead, cancelled.
 *   outcome       what became of it — completed, sent, filtered, superseded,
 *                 abandoned and friends. Terminal transitions only.
 *   outcome_code  why, from the frozen vocabulary below.
 *   outcome_note  the operator-facing sentence.
 *   last_error    an actual exception message. Nothing else, ever.
 *
 * A `WorkOutcome` is the whole decision as one value. Constructing one does
 * nothing; `applyOutcome` in workQueue.js is the only thing that writes, which
 * is what makes "retry vs park vs abandon" a question with one answer instead of
 * six.
 */

import { classifyProviderError, providerErrorPayload, ProviderTransientError } from './providerErrors.js';

/**
 * Lifecycle positions. Anything not claimable is terminal by construction.
 * Kept here rather than in workQueue.js so the vocabulary lives with the policy
 * that assigns it.
 */
export const WORK_STATUSES = Object.freeze(['pending', 'processing', 'retry', 'deferred', 'done', 'dead', 'cancelled']);

/** What became of the work. Written on terminal transitions only. */
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

/**
 * Why, in one word, from a closed set.
 *
 * Frozen and checked at the write. With no test harness in this repo, a
 * vocabulary that throws the moment something invents a code is the cheapest
 * guarantee available that the metrics keep meaning what they say.
 */
export const OUTCOME_CODES = Object.freeze([
  // provider failures, from classifyProviderError
  'provider_inactive',
  'provider_permanent',
  'challenge',
  'rate_limit',
  'timeout',
  'transient',
  'no_evidence',
  // exhaustion
  'attempts_exhausted',
  'parked_out',
  'lease_expired',
  // parked on a resource
  'proxy_missing',
  'provider_paused',
  'llm_budget',
  'geocode_unavailable',
  // policy
  'no_interested_job',
  'provider_removed',
  'already_decided',
  'superseded',
  'merged_duplicate',
  'merged_into_rejected',
  'llm_unextractable',
  'no_market_model',
  // the job's own rules refused the advert; the reason is in source_rejections
  'filtered',
  // domain success
  'captured',
  'parsed',
  'rated',
  'delivered',
  'maintained',
  'trained',
  // the listing stopped being worth delivering
  'listing_gone',
  'listing_not_accepted',
  'listing_hidden',
  'job_disabled',
  'adapter_removed',
]);

const STATUS_SET = new Set(WORK_STATUSES);
const OUTCOME_SET = new Set(WORK_OUTCOMES);
const CODE_SET = new Set(OUTCOME_CODES);

/**
 * @typedef {object} WorkOutcome
 * @property {'error'|'policy'|'filter'|'success'} cause why the work ended
 * @property {'retry'|'park'|'abandon'|'settle'|'cancel'} disposition what to do
 * @property {string} code frozen vocabulary
 * @property {string|null} outcome domain outcome; terminal dispositions only
 * @property {string|null} note operator sentence; never an error message
 * @property {Error|null} error only when cause is 'error'
 * @property {'info'|'warn'|'error'} severity
 * @property {number|null} delayMs retry: explicit delay, else the shared backoff
 * @property {number|null} untilMs park: absolute wake time
 * @property {string|null} counter payload counter to bump instead of attempts
 * @property {object|null} patch payload merge, settle only
 * @property {object|null} classification providerErrorPayload, for the audit
 * @property {{provider: string, scope: 'item'|'discovery', signal: string}|null} providerSignal
 */

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

/** Something threw and it is worth trying again. Costs an attempt. */
export function retryOutcome(
  error,
  { code = 'transient', delayMs = null, counter = null, classification = null } = {},
) {
  return outcome({ cause: 'error', disposition: 'retry', code, error, delayMs, counter, classification });
}

/**
 * Wait for a resource. Costs no attempt, and is bounded by `defer_count` so an
 * item cannot park forever — a provider whose proxy is never configured would
 * otherwise re-park every thirty minutes for the life of the database.
 */
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

/** Out of attempts, or out of parks, or a failure no retry can fix. */
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

/** The work did its job. */
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

/** No longer wanted. A decision, not a failure. */
export function cancelOutcome(code, note) {
  return outcome({ cause: 'policy', disposition: 'cancel', code, note, outcome: 'cancelled', severity: 'info' });
}

/**
 * A job's rules refused the advert.
 *
 * The reason code goes to `outcome_code` and `last_error` is left alone. It used
 * to be written there: `recordSourceRejection` ended with a cancellation whose
 * "reason" was a filter code, so a queue full of perfectly healthy refusals read
 * as a queue full of errors named 'blacklist' and 'spec'. The readable truth was
 * always in `source_rejections`.
 */
export function filterOutcome() {
  return outcome({ cause: 'filter', disposition: 'cancel', code: 'filtered', outcome: 'filtered', severity: 'info' });
}

/**
 * The default policy, keyed on what the error turned out to be.
 *
 * `classifyProviderError` runs for every kind, not just detail capture. A throw
 * that is not a ProviderError becomes transient, which is the right default: an
 * unrecognised failure is more likely a blip than a permanent truth about the
 * advert.
 */
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

/** One minute doubling to an hour, so a blocked provider is retried sparsely. */
function challengeBackoffMs(parks) {
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.min(Number(parks) || 0, 6));
}

/**
 * Turn a thrown error into the decision about it.
 *
 * @param {object} spec the registered handler, which may supply `classify`
 * @param {object} item the claimed work row
 * @param {Error} error
 * @param {{now?: number}} [options]
 * @returns {WorkOutcome}
 */
export function classifyWorkFailure(spec, item, error, { now = Date.now() } = {}) {
  const classified = classifyProviderError(error) ?? new ProviderTransientError(String(error));
  // The one place kind-specific knowledge lives. Parse maps its budget and
  // geocode deferrals here; everything else falls through to the shared table.
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
