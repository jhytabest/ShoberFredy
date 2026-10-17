/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const PERMANENT_ERROR = /json schema|xgrammar|not supported|unsupported|valueerror|invalid.*(schema|request)/i;
const TRANSIENT_ERROR =
  /degraded.*function|function.*degraded|resourceexhausted|worker local total request limit|temporarily|overloaded|capacity|rate.?limit|try again|timeout|503|502/i;
const TRANSIENT_TYPES = new Set([
  'provider_unavailable',
  'provider_overloaded',
  'server',
  'timeout',
  'rate_limit_exceeded',
]);

// OpenRouter can wrap an unavailable provider in HTTP 400. Inspect the typed
// error and the provider's raw details before treating a client status as a
// permanent request error; genuine authentication failures still stay paused.
export function classifyOpenRouterError(error, httpStatus) {
  const status = Number(httpStatus);
  const code = Number(error?.code);
  const metadata = error?.metadata;
  const raw = typeof metadata?.raw === 'string' ? metadata.raw : JSON.stringify(metadata?.raw ?? '');
  const message = `${error?.message || ''}\n${raw}`;
  const outcome = status >= 400 ? 'http_error' : 'upstream_error';
  if ([401, 402, 403].includes(status) || [401, 402, 403].includes(code)) {
    return { outcome, permanent: true };
  }
  if (TRANSIENT_TYPES.has(metadata?.error_type) || (!PERMANENT_ERROR.test(message) && TRANSIENT_ERROR.test(message))) {
    return { outcome: 'upstream_capacity', permanent: false };
  }
  return {
    outcome,
    permanent:
      PERMANENT_ERROR.test(message) ||
      (code >= 400 && code < 500 && ![408, 429].includes(code)) ||
      (status >= 400 && status < 500 && ![408, 429].includes(status)),
  };
}
