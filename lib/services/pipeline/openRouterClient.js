/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { reserveLlmCall, noteUpstreamExhausted, LlmBudgetExhaustedError } from './llmBudget.js';

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
export async function openRouterToolCall({ model, messages, tool, budgetKind = 'live', signal }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  await waitForRateSlot();
  reserveLlmCall(budgetKind);

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    signal: signal || AbortSignal.timeout(120_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/orangecoding/fredy',
      'X-Title': 'Shoberfredy listing parser',
    },
    body: JSON.stringify({
      model,
      messages,
      tools: [tool],
      tool_choice: { type: 'function', function: { name: tool.function.name } },
      temperature: 0,
      // Let both the text and vision models reason before their forced tool call,
      // but do not retain their reasoning trace with the listing data.
      reasoning: { enabled: true, exclude: true },
    }),
  });

  if (response.status === 429) {
    const body = (await response.text()).slice(0, 1000);
    const until = noteUpstreamExhausted(parseResetMs(response, body));
    throw new LlmBudgetExhaustedError(`OpenRouter rate limit: ${body.slice(0, 300)}`, until);
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 1000);
    const error = new Error(`OpenRouter request failed: ${response.status} ${body}`);
    error.status = response.status;
    throw error;
  }

  const payload = await response.json();
  const call = payload?.choices?.[0]?.message?.tool_calls?.find(
    (candidate) => candidate?.function?.name === tool.function.name,
  );
  if (!call?.function?.arguments) throw new Error(`Model did not call ${tool.function.name}`);
  try {
    return { arguments: JSON.parse(call.function.arguments), usage: payload.usage || null };
  } catch (error) {
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
