/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'fs/promises';
import { openRouterToolCall } from './openRouterClient.js';
import { listingTool, validateListing } from './listingSchema.js';

const visionTool = {
  type: 'function',
  function: {
    name: 'submit_visual_summary',
    description: 'Describe only real-estate facts visible in the supplied listing images.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'observations'],
      properties: {
        summary: { type: 'string' },
        observations: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

export async function analyzeImages(images) {
  const startedAt = Date.now();
  const model = process.env.FREDY_LLM_VISION_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
  const stored = (images || []).filter((image) => image.download_status === 'stored' && image.storage_path);
  const summaries = [];
  for (let offset = 0; offset < stored.length; offset += 8) {
    const batch = stored.slice(offset, offset + 8);
    const content = [
      {
        type: 'text',
        text: 'Inspect these listing images in order. Report condition, furnishing, rooms, amenities, damage, floorplans, and text that is genuinely visible. Do not infer price or address.',
      },
    ];
    for (const image of batch) {
      const bytes = await fs.readFile(image.storage_path);
      content.push({ type: 'image_url', image_url: { url: `data:image/webp;base64,${bytes.toString('base64')}` } });
    }
    const result = await openRouterToolCall({
      model,
      messages: [{ role: 'user', content }],
      tool: visionTool,
    });
    summaries.push(result.arguments);
  }
  return { model, summaries, durationMs: Date.now() - startedAt };
}

export async function parseListingWithLlm({ capture, deterministic, visual }) {
  const startedAt = Date.now();
  const model = process.env.FREDY_LLM_TEXT_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
  const prompt = buildPrompt(capture, deterministic, visual);
  let result;
  try {
    result = await callListingTool(model, [{ role: 'user', content: prompt }]);
  } catch (error) {
    if (error?.code !== 'INVALID_TOOL_ARGUMENTS') throw error;
    result = await callListingTool(model, [
      { role: 'user', content: prompt },
      {
        role: 'user',
        content: 'Your previous tool arguments were malformed JSON. Submit one complete, valid tool call.',
      },
    ]);
  }
  let validation = validateListing(result.arguments);
  if (!validation.valid) {
    result = await openRouterToolCall({
      model,
      messages: [
        { role: 'user', content: prompt },
        {
          role: 'user',
          content: `Your previous tool arguments failed structure validation: ${validation.errors.join('; ')}. Submit the complete corrected structure.`,
        },
      ],
      tool: listingTool,
    });
    validation = validateListing(result.arguments);
  }
  if (!validation.valid) throw new Error(`LLM listing structure invalid: ${validation.errors.join('; ')}`);
  return { model, listing: result.arguments, durationMs: Date.now() - startedAt };
}

function callListingTool(model, messages) {
  return openRouterToolCall({ model, messages, tool: listingTool });
}

function buildPrompt(capture, deterministic, visual) {
  return [
    'Normalize this German real-estate listing into the required tool structure.',
    'Use EUR for monetary values, square metres for size, and null when a fact is unavailable.',
    'The page/API evidence is authoritative. Visual observations may add only facts genuinely visible in images.',
    'Deterministic fields are hints and may be corrected by stronger source evidence.',
    `DISCOVERY:\n${JSON.stringify(capture.discoveryData || {})}`,
    `VISIBLE LISTING TEXT:\n${capture.fullText || ''}`,
    `EMBEDDED DATA:\n${JSON.stringify(capture.embeddedData || [])}`,
    `DETERMINISTIC PARSE:\n${JSON.stringify(deterministic || {})}`,
    `VISUAL OBSERVATIONS:\n${JSON.stringify(visual || [])}`,
  ].join('\n\n');
}
