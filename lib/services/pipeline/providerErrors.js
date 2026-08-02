/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export class ProviderError extends Error {
  constructor(message, { kind = 'transient', retryable = true, status = null, retryAfterMs = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProviderError';
    this.code = 'PROVIDER_ERROR';
    this.kind = kind;
    this.retryable = retryable;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class ProviderInactiveError extends ProviderError {
  constructor(message, options = {}) {
    super(message, { ...options, kind: 'inactive', retryable: false });
    this.name = 'ProviderInactiveError';
  }
}

export class ProviderChallengeError extends ProviderError {
  constructor(message, options = {}) {
    super(message, { ...options, kind: 'challenge', retryable: true });
    this.name = 'ProviderChallengeError';
  }
}

export class ProviderRateLimitError extends ProviderError {
  constructor(message, options = {}) {
    super(message, { ...options, kind: 'rate_limit', retryable: true });
    this.name = 'ProviderRateLimitError';
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(message, options = {}) {
    super(message, { ...options, kind: 'timeout', retryable: true });
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderTransientError extends ProviderError {
  constructor(message, options = {}) {
    super(message, { ...options, kind: 'transient', retryable: true });
    this.name = 'ProviderTransientError';
  }
}

export class ProviderPermanentError extends ProviderError {
  constructor(message, options = {}) {
    super(message, { ...options, kind: 'permanent', retryable: false });
    this.name = 'ProviderPermanentError';
  }
}

/**
 * The one HTTP status -> ProviderError mapping.
 *
 * Providers used to carry their own copies, and they disagreed on the case that
 * matters most: ImmoScout mapped every remaining 4xx to permanent, which swallows
 * 401 and 403. Because `classifyProviderError` passes an already-typed error
 * through untouched, a datacenter-IP 403 was abandoned advert by advert — exactly
 * the failure the comment below says was fixed for the generic path.
 *
 * @param {{status: number, statusText?: string}} response
 * @param {{message?: string, retryAfterMs?: number|null}} [options]
 * @returns {ProviderError}
 */
export function providerErrorForResponse(response, { message, retryAfterMs = null } = {}) {
  const status = Number(response?.status);
  const text = message ?? `Provider returned ${status} ${response?.statusText ?? ''}`.trim();
  if (status === 404 || status === 410) return new ProviderInactiveError(text, { status });
  if (status === 429) return new ProviderRateLimitError(text, { status, retryAfterMs });
  if (status === 401 || status === 403) return new ProviderChallengeError(text, { status });
  if (status >= 500 || [408, 425].includes(status)) return new ProviderTransientError(text, { status });
  if (Number.isFinite(status) && status >= 400) return new ProviderPermanentError(text, { status });
  return new ProviderTransientError(text, { status: Number.isFinite(status) ? status : null });
}

export function classifyProviderError(error) {
  if (error instanceof ProviderError) return error;
  if (error?.code === 'OPERATION_DEADLINE' || error?.name === 'TimeoutError') {
    return new ProviderTimeoutError(error.message, { cause: error });
  }
  const status = Number(error?.status);
  if (status === 404 || status === 410) {
    return new ProviderInactiveError(error.message, { status, cause: error });
  }
  if (status === 429) {
    return new ProviderRateLimitError(error.message, { status, cause: error });
  }
  // A portal that refuses to talk to this IP is not a portal that lost the
  // advert. Immowelt answers every request from a datacenter address with 403,
  // and filing that as permanent abandoned each listing individually while the
  // real problem — no proxy — went unreported.
  if (status === 401 || status === 403) {
    return new ProviderChallengeError(error.message, { status, cause: error });
  }
  if (Number.isFinite(status) && status >= 400 && status < 500) {
    return new ProviderPermanentError(error.message, { status, cause: error });
  }
  return new ProviderTransientError(error?.message || String(error), {
    status: Number.isFinite(status) ? status : null,
    cause: error instanceof Error ? error : undefined,
  });
}

export function providerErrorPayload(error) {
  return {
    kind: error.kind,
    retryable: error.retryable,
    status: error.status,
    retryAfterMs: error.retryAfterMs,
    name: error.name,
  };
}
