/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { reserveLlmCall, noteUpstreamExhausted, LlmBudgetExhaustedError } from './llmBudget.js';
import { beginLlmAudit, finishLlmAudit } from './llmAuditStorage.js';
import { OperationDeadlineError, withOperationDeadline } from './operationDeadline.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const requestTimes = [];

/**
 * Execute one forced tool call against OpenRouter.
 *
 * Every invocation consumes exactly one unit of the daily LLM budget for
 * `budgetKind` ('live' | 'backfill') before the request is sent. When the
 * budget is exhausted, or OpenRouter itself answers 429, this throws
 * {@link LlmBudgetExhaustedError} carrying `retryAtMs` — callers defer and
 * wait, they never fall back or fail the queue item.
 *
 * @param {{model: string, messages: object[], tool: object, budgetKind: 'live'|'backfill', signal?: AbortSignal}} options
 * @returns {Promise<{arguments: object, usage: object|null}>}
 */
export async function openRouterToolCall({ model, messages, tool, budgetKind = 'live', signal, audit = {} }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  await waitForRateSlot();
  reserveLlmCall(budgetKind);

  const request = {
    model,
    messages,
    tools: [tool],
    tool_choice: { type: 'function', function: { name: tool.function.name } },
    temperature: 0,
    reasoning: { enabled: true, exclude: true },
  };
  const auditId = beginLlmAudit({
    context: { ...audit, queueKind: budgetKind },
    model,
    toolName: tool.function.name,
    request,
  });

  let response;
  let responseBody;
  try {
    const result = await withOperationDeadline(
      async (deadlineSignal) => {
        const fetched = await fetch(ENDPOINT, {
          method: 'POST',
          signal: deadlineSignal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/orangecoding/fredy',
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
        timeoutMs: positiveEnv('FREDY_LLM_REQUEST_TIMEOUT_MS', 120_000),
        signal,
        name: `OpenRouter ${audit.operation || tool.function.name}`,
      },
    );
    response = result.response;
    responseBody = result.responseBody;
  } catch (error) {
    finishLlmAudit(auditId, {
      outcome:
        error instanceof OperationDeadlineError ? 'timeout' : response ? 'response_read_error' : 'transport_error',
      httpStatus: response?.status,
      responseHeaders: response ? headersForAudit(response.headers) : null,
      error: error.message,
    });
    throw error;
  }
  const responseHeaders = headersForAudit(response.headers);

  if (response.status === 429) {
    finishLlmAudit(auditId, {
      outcome: 'rate_limited',
      httpStatus: response.status,
      responseBody,
      responseHeaders,
    });
    const until = noteUpstreamExhausted(parseResetMs(response, responseBody));
    throw new LlmBudgetExhaustedError(`OpenRouter rate limit: ${responseBody.slice(0, 300)}`, until);
  }
  if (!response.ok) {
    finishLlmAudit(auditId, {
      outcome: 'http_error',
      httpStatus: response.status,
      responseBody,
      responseHeaders,
    });
    const error = new Error(`OpenRouter request failed: ${response.status} ${responseBody.slice(0, 1000)}`);
    error.status = response.status;
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(responseBody);
  } catch (error) {
    finishLlmAudit(auditId, {
      outcome: 'invalid_response_json',
      httpStatus: response.status,
      responseBody,
      responseHeaders,
      error: error.message,
    });
    throw new Error(`OpenRouter returned invalid JSON: ${error.message}`, { cause: error });
  }
  // Free-tier providers (e.g. Nvidia NIM) frequently answer HTTP 200 wrapping a
  // transient upstream error ("ResourceExhausted: Worker local total request
  // limit reached (32/32)", code 502). Treat these like a 429: globally defer
  // and wait for capacity to return instead of burning retries+budget on a hard
  // failure. `reserveLlmCall` checks the block before incrementing, so queued
  // items wait without consuming budget; the block window is bounded to avoid
  // hammering the endpoint.
  if (payload?.error && isTransientUpstreamError(payload.error)) {
    finishLlmAudit(auditId, {
      outcome: 'upstream_capacity',
      httpStatus: response.status,
      responseBody,
      responseHeaders,
      usage: payload.usage,
      error: String(payload.error.message || 'upstream capacity exhausted'),
    });
    const backoffMs = positiveEnv('FREDY_LLM_UPSTREAM_BACKOFF_MS', 60_000);
    const until = noteUpstreamExhausted(Date.now() + backoffMs);
    throw new LlmBudgetExhaustedError(
      `OpenRouter upstream capacity: ${String(payload.error.message || '').slice(0, 200)}`,
      until,
    );
  }
  const call = payload?.choices?.[0]?.message?.tool_calls?.find(
    (candidate) => candidate?.function?.name === tool.function.name,
  );
  if (!call?.function?.arguments) {
    finishLlmAudit(auditId, {
      outcome: 'missing_tool_call',
      httpStatus: response.status,
      responseBody,
      responseHeaders,
      usage: payload.usage,
      error: `Model did not call ${tool.function.name}`,
    });
    throw new Error(`Model did not call ${tool.function.name}`);
  }
  try {
    const args = JSON.parse(call.function.arguments);
    finishLlmAudit(auditId, {
      outcome: 'success',
      httpStatus: response.status,
      responseBody,
      responseHeaders,
      usage: payload.usage,
    });
    return { arguments: args, usage: payload.usage || null, auditId };
  } catch (error) {
    finishLlmAudit(auditId, {
      outcome: 'invalid_tool_json',
      httpStatus: response.status,
      responseBody,
      responseHeaders,
      usage: payload.usage,
      error: error.message,
    });
    const invalid = new Error(`Model returned invalid tool JSON: ${error.message}`, { cause: error });
    invalid.code = 'INVALID_TOOL_ARGUMENTS';
    throw invalid;
  }
}

/**
 * Extract the most reliable reset time from a 429 response. OpenRouter's
 * `X-RateLimit-Reset` (header and body metadata) is an epoch timestamp —
 * observed in milliseconds, but normalized here in case a proxy or API
 * change delivers seconds, since a seconds value read as ms would place the
 * reset in 1970 and effectively disable the block. `retry-after` is seconds.
 *
 * @param {Response} response
 * @param {string} body
 * @returns {number|null} epoch ms, or null when the provider gave none
 */
function parseResetMs(response, body) {
  const headerReset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(headerReset) && headerReset > 0) return epochToMs(headerReset);
  const bodyReset = Number(/"X-RateLimit-Reset"\s*:\s*"?(\d+)"?/.exec(body)?.[1]);
  if (Number.isFinite(bodyReset) && bodyReset > 0) return epochToMs(bodyReset);
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Date.now() + retryAfter * 1000;
  return null;
}

/** Epoch timestamps below 10^11 (year 5138 in seconds, 1973 in ms) are seconds. */
function epochToMs(value) {
  return value < 1e11 ? value * 1000 : value;
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

/**
 * Whether a 200-wrapped provider error is a transient capacity/overload signal
 * (retry later) rather than a permanent request problem.
 * @param {{code?: number|string, message?: string}} error
 * @returns {boolean}
 */
function isTransientUpstreamError(error) {
  const code = Number(error?.code);
  if (Number.isFinite(code) && code >= 500) return true;
  return /resourceexhausted|worker local total request limit|temporarily|overloaded|capacity|rate.?limit|try again|timeout|503|502/i.test(
    String(error?.message || ''),
  );
}

async function waitForRateSlot() {
  const limit = positiveEnv('FREDY_OPENROUTER_REQUESTS_PER_MINUTE', 18);
  while (true) {
    const now = Date.now();
    while (requestTimes.length && requestTimes[0] <= now - 60_000) requestTimes.shift();
    if (requestTimes.length < limit) {
      requestTimes.push(now);
      return;
    }
    const waitMs = Math.max(50, requestTimes[0] + 60_000 - now);
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 60_000)));
  }
}

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
