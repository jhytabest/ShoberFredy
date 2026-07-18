/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const requestTimes = [];

export async function openRouterToolCall({ model, messages, tool, signal }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  await waitForRateSlot();

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

  if (!response.ok) {
    const body = (await response.text()).slice(0, 1000);
    const error = new Error(`OpenRouter request failed: ${response.status} ${body}`);
    error.status = response.status;
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter)) error.retryAfterMs = retryAfter * 1000;
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
