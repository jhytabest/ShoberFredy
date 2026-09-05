/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getJob } from '../../services/storage/jobStorage.js';
import fetch from 'node-fetch';
import pThrottle from 'p-throttle';
import { normalizeImageUrl } from '../../utils.js';
import logger from '../../services/logger.js';
import { shouldUseMultipart, buildLocalPhotoFormData, buildPhotoFormData } from './telegramPhotoUploader.js';

const RATE_LIMIT_INTERVAL = 1000;
const THROTTLE_MAX_IDLE_MS = RATE_LIMIT_INTERVAL + 2000;
const chatThrottleMap = new Map();

function cleanupOldThrottles() {
  const now = Date.now();
  for (const [chatId, chatThrottle] of chatThrottleMap.entries()) {
    if (now - chatThrottle.lastUsedAt > THROTTLE_MAX_IDLE_MS) chatThrottleMap.delete(chatId);
  }
}

function getThrottled(chatId, call) {
  cleanupOldThrottles();
  const existing = chatThrottleMap.get(chatId);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing.throttled;
  }
  const entry = { lastUsedAt: Date.now(), throttled: null };
  chatThrottleMap.set(chatId, entry);
  entry.throttled = pThrottle({ limit: 1, interval: RATE_LIMIT_INTERVAL })(async (endpoint, body) => {
    const e = chatThrottleMap.get(chatId);
    if (e) e.lastUsedAt = Date.now();
    return call(endpoint, body);
  });
  return entry.throttled;
}

function shorten(str, len = 90) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len).trim() + '...' : str;
}

function escapeHtml(s = '') {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function factsLine(o, esc) {
  if (Array.isArray(o.facts) && o.facts.length) {
    return o.facts.map((fact) => `${esc(fact.label)}: ${esc(fact.value)}`).join(' · ');
  }
  return [o.price, o.size].filter(Boolean).map(esc).join(' · ');
}

function buildBody(jobName, serviceName, o, html) {
  const esc = html ? escapeHtml : (value) => value;
  const title = shorten((o.title || '').replace(/\*/g, ''), 90);
  const lines = [];
  lines.push(html ? `<i>${esc(jobName)}</i> (${esc(serviceName)})` : `${jobName} (${serviceName})`);
  lines.push(html ? `<a href='${esc(o.link || '')}'><b>${esc(title)}</b></a>` : title);
  if (!html && o.link) lines.push(o.link);
  const facts = factsLine(o, esc);
  if (facts) lines.push(facts);
  if (o.address) lines.push(esc(o.address));
  if (o.summary) lines.push(html ? `<i>${esc(o.summary)}</i>` : o.summary);
  if (o.comments) lines.push(esc(o.comments));
  return lines.join('\n');
}

function buildHtmlBody(jobName, serviceName, o) {
  return buildBody(jobName, serviceName, o, true);
}

const CAPTION_LIMIT = 1024;

function clipHtmlCaption(html) {
  if (html.length <= CAPTION_LIMIT) return html;
  const lines = html.split('\n');
  while (lines.length > 1) {
    lines.pop();
    const kept = lines.join('\n');
    if (kept.length <= CAPTION_LIMIT) return kept;
  }
  return html
    .replace(/<[^>]*>/g, '')
    .slice(0, CAPTION_LIMIT)
    .replace(/&[a-z]*;?$/i, '');
}

function buildPlainCaption(jobName, serviceName, o) {
  return buildBody(jobName, serviceName, o, false).slice(0, CAPTION_LIMIT);
}

function buildPlainText(jobName, serviceName, o) {
  return buildBody(jobName, serviceName, o, false);
}

function makeTelegramCaller(token, jobName) {
  return async function (endpoint, body) {
    const isFormData = body instanceof FormData;
    const opts = isFormData
      ? { method: 'post', body }
      : { method: 'post', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
    const res = await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, opts);
    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`API error for '${jobName}'. '${endpoint}' returned ${errorBody}`);
    }
    return res;
  };
}

async function sendListingToChat(
  throttledCall,
  listing,
  chatId,
  { jobName, serviceName, plainText, message_thread_id },
) {
  const img = normalizeImageUrl(listing.image);
  const imagePath = typeof listing.imagePath === 'string' && listing.imagePath.trim() ? listing.imagePath.trim() : null;

  const textPayload = {
    chat_id: chatId,
    text: plainText ? buildPlainText(jobName, serviceName, listing) : buildHtmlBody(jobName, serviceName, listing),
    ...(plainText ? {} : { parse_mode: 'HTML' }),
    disable_web_page_preview: true,
    ...(message_thread_id ? { message_thread_id } : {}),
  };

  if (!img && !imagePath) {
    return throttledCall('sendMessage', textPayload).catch((e) => {
      logger.error(`Error sending message to Telegram: ${e.message}`);
    });
  }

  const caption = plainText
    ? buildPlainCaption(jobName, serviceName, listing)
    : clipHtmlCaption(buildHtmlBody(jobName, serviceName, listing));
  const parseMode = plainText ? undefined : 'HTML';

  const photoAttempts = [];
  if (imagePath) {
    photoAttempts.push(async () => {
      const form = await buildLocalPhotoFormData({
        chatId,
        imagePath,
        caption,
        parseMode,
        messageThreadId: message_thread_id,
      });
      return throttledCall('sendPhoto', form);
    });
  }
  if (img) {
    photoAttempts.push(() =>
      shouldUseMultipart(img)
        ? buildPhotoFormData({
            chatId,
            imageUrl: img,
            caption,
            parseMode,
            messageThreadId: message_thread_id,
          }).then((fd) => throttledCall('sendPhoto', fd))
        : throttledCall('sendPhoto', {
            chat_id: chatId,
            photo: img,
            caption,
            ...(parseMode ? { parse_mode: parseMode } : {}),
            ...(message_thread_id ? { message_thread_id } : {}),
          }),
    );
  }

  for (const attempt of photoAttempts) {
    try {
      return await attempt();
    } catch (error) {
      logger.warn(`Telegram photo attempt failed; trying the next image layer: ${error.message}`);
    }
  }
  return throttledCall('sendMessage', textPayload).catch((error) => {
    logger.error(`Error sending message to Telegram: ${error.message}`);
    throw error;
  });
}

export const send = ({ serviceName, newListings = [], adapter, jobKey }) => {
  if (!adapter?.fields) {
    throw new Error(`Telegram adapter configuration missing for job '${jobKey || ''}'`);
  }
  const { token, chatId, messageThreadId, plainText } = adapter.fields;
  if (!token || !chatId) {
    throw new Error("Telegram 'token' and 'chatId' must be provided in notification config");
  }

  const chatIds = String(chatId)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let message_thread_id;
  if (messageThreadId !== undefined && messageThreadId !== null && `${messageThreadId}`.trim() !== '') {
    const n = Number(messageThreadId);
    if (Number.isInteger(n) && n > 0) {
      message_thread_id = n;
    } else {
      logger.warn(
        `Telegram adapter: 'messageThreadId' is invalid ('${messageThreadId}'). It must be a positive integer. Ignoring.`,
      );
    }
  }

  const job = getJob(jobKey);
  const jobName = job == null ? jobKey : job.name;

  if (!Array.isArray(newListings) || newListings.length === 0) return Promise.resolve([]);

  const allPromises = chatIds.flatMap((id) => {
    const caller = makeTelegramCaller(token, jobName);
    const throttledCall = getThrottled(id, caller);
    const opts = { jobName, serviceName, plainText, message_thread_id };
    return newListings.map((listing) => sendListingToChat(throttledCall, listing, id, opts));
  });

  return Promise.all(allPromises);
};

export const config = {
  id: 'telegram',
  name: 'Telegram',
  readme: '<p>Configure this adapter using the fields below.</p>',
  description: 'Fredy will send new listings to your mobile, using Telegram.',
  fields: {
    token: {
      type: 'text',
      label: 'Token',
      description: 'The token needed to access this service.',
    },
    chatId: {
      type: 'chatId',
      label: 'Chat Id',
      description:
        'The chat ID to send messages to. Separate multiple IDs with commas to notify several recipients (e.g. 123456789, 987654321).',
    },
    messageThreadId: {
      type: 'text',
      optional: true,
      label: 'Message Thread Id (optional)',
      description:
        'Optional: The topic/thread id within a supergroup to post into (Telegram message_thread_id). Provide a positive integer.',
    },
    plainText: {
      type: 'boolean',
      optional: true,
      label: 'Send as plain text',
      description: 'Send messages as plain text instead of HTML formatted.',
    },
  },
};
