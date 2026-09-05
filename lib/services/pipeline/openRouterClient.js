/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { reserveLlmCall, noteUpstreamExhausted, LlmBudgetExhaustedError } from './llmBudget.js';
import { beginLlmAudit, finishLlmAudit } from './llmAuditStorage.js';
import { OperationDeadlineError, withOperationDeadline } from './operationDeadline.js';
import { env } from '../../shared/env.js';
import { setTimeout as delay } from 'node:timers/promises';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const requestTimes = [];

// Every way this call can end is an audit row differing only in `outcome`, so
// failures carry theirs and one `finally` writes the row. The alternative —
// repeating the audit call at each rejection — drifted: fields were passed at
// some exits and forgotten at others.
class LlmCallError extends Error {
  constructor(message, { outcome, code = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'LlmCallError';
    this.outcome = outcome;
    if (code) this.code = code;
  }
}

export async function openRouterToolCall({ model, messages, tool, signal, audit = {}, fallbackAvailable = false }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  signal?.throwIfAborted();
  await waitForRateSlot(signal);
  signal?.throwIfAborted();
  reserveLlmCall();

  const request = {
    model,
    messages,
    tools: [tool],
    tool_choice: { type: 'function', function: { name: tool.function.name } },
    provider: { require_parameters: true },
    temperature: 0,
    reasoning: { enabled: false },
  };
  const auditId = beginLlmAudit({ context: audit, model, toolName: tool.function.name, request });

  let response = null;
  let responseBody = null;
  let payload = null;
  let outcome = 'success';
  let auditError = null;

  try {
    const result = await withOperationDeadline(
      async (deadlineSignal) => {
        const fetched = await fetch(ENDPOINT, {
          method: 'POST',
          signal: deadlineSignal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/jhytabest/ShoberFredy',
            'X-Title': 'Shoberfredy listing parser',
          },
          body: JSON.stringify(request),
        });
        response = fetched;
        const body = await fetched.text();
        deadlineSignal.throwIfAborted();
        return { response: fetched, responseBody: body };
      },
      {
        timeoutMs: env('FREDY_LLM_REQUEST_TIMEOUT_MS'),
        signal,
        name: `OpenRouter ${audit.operation || tool.function.name}`,
      },
    );
    response = result.response;
    responseBody = result.responseBody;

    if (response.status === 429) {
      const until = noteUpstreamExhausted(parseResetMs(response, responseBody), { fromUpstream: true });
      throw new LlmBudgetExhaustedError(`OpenRouter rate limit: ${responseBody.slice(0, 300)}`, until);
    }
    if (!response.ok) {
      const error = new LlmCallError(`OpenRouter request failed: ${response.status} ${responseBody.slice(0, 1000)}`, {
        outcome: 'http_error',
      });
      error.fallbackEligible = response.status === 404 || response.status >= 500;
      throw error;
    }

    try {
      payload = JSON.parse(responseBody);
    } catch (error) {
      throw new LlmCallError(`OpenRouter returned invalid JSON: ${error.message}`, {
        outcome: 'invalid_response_json',
        cause: error,
      });
    }

    if (payload?.error && isTransientUpstreamError(payload.error)) {
      if (fallbackAvailable) {
        const error = new LlmCallError('Extraction model has no upstream capacity', { outcome: 'upstream_capacity' });
        error.fallbackEligible = true;
        throw error;
      }
      const until = noteUpstreamExhausted(Date.now() + env('FREDY_LLM_UPSTREAM_BACKOFF_MS'));
      throw new LlmBudgetExhaustedError(
        `OpenRouter upstream capacity: ${String(payload.error.message || '').slice(0, 200)}`,
        until,
      );
    }
    if (payload?.error) {
      throw new LlmCallError(
        `OpenRouter upstream error: ${String(payload.error.message || 'upstream error').slice(0, 300)}`,
        {
          outcome: 'upstream_error',
        },
      );
    }

    const call = payload?.choices?.[0]?.message?.tool_calls?.find(
      (candidate) => candidate?.function?.name === tool.function.name,
    );
    if (!call?.function?.arguments) {
      throw new LlmCallError(`Model did not call ${tool.function.name}`, { outcome: 'missing_tool_call' });
    }

    let args;
    try {
      args = JSON.parse(call.function.arguments);
    } catch (error) {
      throw new LlmCallError(`Model returned invalid tool JSON: ${error.message}`, {
        outcome: 'invalid_tool_json',
        code: 'INVALID_TOOL_ARGUMENTS',
        cause: error,
      });
    }
    return { arguments: args, usage: payload.usage || null, auditId };
  } catch (error) {
    outcome =
      error instanceof LlmBudgetExhaustedError
        ? response?.status === 429
          ? 'rate_limited'
          : 'upstream_capacity'
        : (error.outcome ?? classifyRequestFailure(error, response));
    auditError = error.message;
    error.fallbackEligible ??= ['timeout', 'transport_error', 'missing_tool_call'].includes(outcome);
    throw error;
  } finally {
    finishLlmAudit(auditId, {
      outcome,
      httpStatus: response?.status,
      responseBody,
      responseHeaders: response ? headersForAudit(response.headers) : null,
      usage: payload?.usage,
      error: auditError,
    });
  }
}

function parseResetMs(response, body) {
  const headerReset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(headerReset) && headerReset > 0) return epochToMs(headerReset);
  const bodyReset = Number(/"X-RateLimit-Reset"\s*:\s*"?(\d+)"?/.exec(body)?.[1]);
  if (Number.isFinite(bodyReset) && bodyReset > 0) return epochToMs(bodyReset);
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Date.now() + retryAfter * 1000;
  return null;
}

function epochToMs(value) {
  return value < 1e11 ? value * 1000 : value;
}

function errorChain(error) {
  const chain = [];
  let current = error;
  while (current instanceof Error && chain.length < 8 && !chain.includes(current)) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

function classifyRequestFailure(error, response) {
  const chain = errorChain(error);
  if (chain.some((link) => link instanceof OperationDeadlineError)) return 'timeout';
  if (chain.some((link) => link.name === 'TimeoutError' || TIMEOUT_CODES.has(link.code))) return 'timeout';
  if (chain.some((link) => link.name === 'AbortError' || link.code === 'ABORT_ERR')) return 'aborted';
  return response ? 'response_read_error' : 'transport_error';
}

function headersForAudit(headers) {
  if (typeof headers?.entries === 'function') return Object.fromEntries(headers.entries());
  const result = {};
  for (const name of [
    'content-type',
    'retry-after',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
  ]) {
    const value = headers?.get?.(name);
    if (value != null) result[name] = value;
  }
  return result;
}

const PERMANENT_UPSTREAM_ERROR = /json schema|xgrammar|not supported|unsupported|valueerror|invalid.*(schema|request)/i;

function isTransientUpstreamError(error) {
  const message = String(error?.message || '');
  if (PERMANENT_UPSTREAM_ERROR.test(message)) return false;
  const code = Number(error?.code);
  if (Number.isFinite(code) && code >= 500) return true;
  return /resourceexhausted|worker local total request limit|temporarily|overloaded|capacity|rate.?limit|try again|timeout|503|502/i.test(
    message,
  );
}

async function waitForRateSlot(signal) {
  const limit = env('FREDY_OPENROUTER_REQUESTS_PER_MINUTE');
  while (true) {
    signal?.throwIfAborted();
    const now = Date.now();
    while (requestTimes.length && requestTimes[0] <= now - 60_000) requestTimes.shift();
    if (requestTimes.length < limit) {
      requestTimes.push(now);
      return;
    }
    const waitMs = Math.max(50, requestTimes[0] + 60_000 - now);
    await delay(Math.min(waitMs, 60_000), undefined, { signal });
  }
}
