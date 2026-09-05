/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'node:fs/promises';
import sharp from 'sharp';

const TELEGRAM_MULTIPART_MAX_BYTES = 10 * 1024 * 1024;

const NON_WEBP_ACCEPT = 'image/jpeg,image/png,image/*;q=0.8';

export function shouldUseMultipart(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return /\.webp$/i.test(parsed.pathname);
}

export async function buildPhotoFormData({ chatId, imageUrl, caption, parseMode, messageThreadId, signal }) {
  const timeout = AbortSignal.timeout(30_000);
  const res = await fetch(imageUrl, {
    method: 'GET',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Accept: NON_WEBP_ACCEPT },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch image for multipart upload (${res.status}): ${imageUrl}`);
  }

  const advertised = Number(res.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > TELEGRAM_MULTIPART_MAX_BYTES) {
    throw new Error(
      `Image exceeds Telegram multipart size limit (advertised ${advertised} bytes, max ${TELEGRAM_MULTIPART_MAX_BYTES}): ${imageUrl}`,
    );
  }

  const buf = await res.arrayBuffer();
  if (buf.byteLength > TELEGRAM_MULTIPART_MAX_BYTES) {
    throw new Error(
      `Image exceeds Telegram multipart size limit (downloaded ${buf.byteLength} bytes, max ${TELEGRAM_MULTIPART_MAX_BYTES}): ${imageUrl}`,
    );
  }

  const blob = new Blob([buf], { type: 'image/jpeg' });

  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('caption', caption);
  if (parseMode) fd.append('parse_mode', parseMode);
  if (messageThreadId != null) fd.append('message_thread_id', String(messageThreadId));
  fd.append('photo', blob, 'photo.jpg');
  return fd;
}

export async function buildLocalPhotoFormData({ chatId, imagePath, caption, parseMode, messageThreadId }) {
  if (typeof imagePath !== 'string' || !imagePath.trim()) {
    throw new Error('Stored image path is missing');
  }
  const stat = await fs.stat(imagePath);
  if (!stat.isFile()) throw new Error(`Stored image is not a file: ${imagePath}`);
  if (stat.size > TELEGRAM_MULTIPART_MAX_BYTES) {
    throw new Error(
      `Stored image exceeds Telegram multipart size limit (${stat.size} bytes, max ${TELEGRAM_MULTIPART_MAX_BYTES})`,
    );
  }
  const bytes = await fs.readFile(imagePath);
  const jpeg = await sharp(bytes, { animated: false })
    .rotate()
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer();
  if (jpeg.length > TELEGRAM_MULTIPART_MAX_BYTES) {
    throw new Error(
      `Converted image exceeds Telegram multipart size limit (${jpeg.length} bytes, max ${TELEGRAM_MULTIPART_MAX_BYTES})`,
    );
  }
  const blob = new Blob([jpeg], { type: 'image/jpeg' });
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('caption', caption);
  if (parseMode) fd.append('parse_mode', parseMode);
  if (messageThreadId != null) fd.append('message_thread_id', String(messageThreadId));
  fd.append('photo', blob, 'photo.jpg');
  return fd;
}
