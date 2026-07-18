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

/**
 * Analyze the listing gallery in a single vision-model request (one LLM call
 * per listing for pictures). At most `FREDY_LLM_VISION_MAX_IMAGES` stored
 * images are attached (default 8).
 *
 * @param {object[]} images listing_images rows
 * @param {{budgetKind?: 'live'|'backfill'}} [options]
 * @returns {Promise<{model: string, summaries: object[], durationMs: number}|null>}
 *   null when there is no stored image to analyze
 */
export async function analyzeImages(images, { budgetKind = 'live' } = {}) {
  const startedAt = Date.now();
  const model = process.env.FREDY_LLM_VISION_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
  const maxImages = positiveEnv('FREDY_LLM_VISION_MAX_IMAGES', 8);
  const stored = (images || []).filter((image) => image.download_status === 'stored' && image.storage_path);
  if (stored.length === 0) return null;

  const content = [
    {
      type: 'text',
      text: 'Inspect these listing images in order. Report condition, furnishing, rooms, amenities, damage, floorplans, and text that is genuinely visible. Do not infer price or address.',
    },
  ];
  for (const image of stored.slice(0, maxImages)) {
    const bytes = await fs.readFile(image.storage_path);
    content.push({ type: 'image_url', image_url: { url: `data:image/webp;base64,${bytes.toString('base64')}` } });
  }
  const result = await openRouterToolCall({
    model,
    messages: [{ role: 'user', content }],
    tool: visionTool,
    budgetKind,
  });
  return { model, summaries: [result.arguments], durationMs: Date.now() - startedAt };
}

/**
 * Extract the structured listing from the captured page evidence (one LLM
 * call per listing for text; schema-validation retries are the exception,
 * each consuming an additional budgeted request).
 *
 * @param {{capture: object, visual: object[]|null, budgetKind?: 'live'|'backfill'}} input
 * @returns {Promise<{model: string, listing: object, durationMs: number}>}
 */
export async function parseListingWithLlm({ capture, visual, budgetKind = 'live' }) {
  const startedAt = Date.now();
  const model = process.env.FREDY_LLM_TEXT_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
  const prompt = buildPrompt(capture, visual);
  let result;
  try {
    result = await callListingTool(model, [{ role: 'user', content: prompt }], budgetKind);
  } catch (error) {
    if (error?.code !== 'INVALID_TOOL_ARGUMENTS') throw error;
    result = await callListingTool(
      model,
      [
        { role: 'user', content: prompt },
        {
          role: 'user',
          content: 'Your previous tool arguments were malformed JSON. Submit one complete, valid tool call.',
        },
      ],
      budgetKind,
    );
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
      budgetKind,
    });
    validation = validateListing(result.arguments);
  }
  if (!validation.valid) throw new Error(`LLM listing structure invalid: ${validation.errors.join('; ')}`);
  return { model, listing: result.arguments, durationMs: Date.now() - startedAt };
}

function callListingTool(model, messages, budgetKind) {
  return openRouterToolCall({ model, messages, tool: listingTool, budgetKind });
}

function buildPrompt(capture, visual) {
  const sections = [
    'Extract this German real-estate listing into the required tool structure.',
    'Use EUR for monetary values, square metres for size, and null when a fact is unavailable.',
    'Categorical fields accept only their listed enum values — map German terms to the closest value.',
    'Availability: set availability to "immediate" for sofort/ab sofort, "date" with an ISO available_from when a concrete date is named, "flexible" for nach Vereinbarung/Absprache.',
    'Put every remaining relevant fact that does not fit the fields into `comments` (original language, concise).',
    'The page/API evidence is authoritative. Visual observations may add only facts genuinely visible in images.',
    `DISCOVERY:\n${JSON.stringify(capture.discoveryData || {})}`,
    `VISIBLE LISTING TEXT:\n${capture.fullText || ''}`,
    `EMBEDDED DATA:\n${JSON.stringify(capture.embeddedData || [])}`,
  ];
  if (visual) sections.push(`VISUAL OBSERVATIONS:\n${JSON.stringify(visual)}`);
  return sections.join('\n\n');
}

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
