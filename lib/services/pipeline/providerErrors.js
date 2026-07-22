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
