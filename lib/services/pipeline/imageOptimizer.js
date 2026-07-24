/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { computeDbPath } from '../storage/SqliteConnection.js';

const MAX_IMAGE_BYTES = 20_000;
const INITIAL_EDGE = 1024;
const INITIAL_QUALITY = 45;
const MIN_QUALITY = 5;
const DOWNLOAD_LIMIT_BYTES = 25 * 1024 * 1024;

export async function downloadAndOptimizeImages(images, { concurrency = 4 } = {}) {
  const source = dedupeImages(images);
  const results = new Array(source.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, source.length)) }, async () => {
    while (nextIndex < source.length) {
      const index = nextIndex++;
      const image = source[index];
      try {
        results[index] = await downloadAndOptimizeImage(image);
      } catch (error) {
        results[index] = {
          ...image,
          downloadStatus: 'failed',
          error: String(error?.message || error).slice(0, 1000),
        };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function downloadAndOptimizeImage(image) {
  if (!image?.originalUrl) throw new Error('Image URL is missing');
  const response = await fetch(image.originalUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
    headers: { 'User-Agent': 'Mozilla/5.0 shoberfredy-media/1.0' },
  });
  if (!response.ok) throw new Error(`Image download failed: ${response.status} ${response.statusText}`);

  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > DOWNLOAD_LIMIT_BYTES) throw new Error('Image exceeds 25 MB download limit');
  const sourceBuffer = Buffer.from(await response.arrayBuffer());
  if (sourceBuffer.length > DOWNLOAD_LIMIT_BYTES) throw new Error('Image exceeds 25 MB download limit');

  const optimized = await optimizeImageBuffer(sourceBuffer);
  const contentHash = crypto.createHash('sha256').update(optimized.buffer).digest('hex');
  const { dir } = await computeDbPath();
  const mediaDir = path.join(dir, 'media', contentHash.slice(0, 2));
  const storagePath = path.join(mediaDir, `${contentHash}.webp`);
  await fs.mkdir(mediaDir, { recursive: true });
  try {
    await fs.writeFile(storagePath, optimized.buffer, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  return {
    ...image,
    storagePath,
    contentHash,
    mimeType: 'image/webp',
    byteSize: optimized.buffer.length,
    width: optimized.width,
    height: optimized.height,
    downloadStatus: 'stored',
    error: null,
  };
}

async function optimizeImageBuffer(sourceBuffer) {
  const metadata = await sharp(sourceBuffer, { animated: false, limitInputPixels: 100_000_000 }).metadata();
  const originalEdge = Math.max(metadata.width || INITIAL_EDGE, metadata.height || INITIAL_EDGE);
  let edge = Math.min(INITIAL_EDGE, originalEdge);

  while (edge >= 64) {
    const minimum = await encode(sourceBuffer, edge, MIN_QUALITY);
    if (minimum.buffer.length <= MAX_IMAGE_BYTES) {
      let best = minimum;
      let low = MIN_QUALITY + 1;
      let high = INITIAL_QUALITY;
      while (low <= high) {
        const quality = Math.floor((low + high) / 2);
        const candidate = await encode(sourceBuffer, edge, quality);
        if (candidate.buffer.length <= MAX_IMAGE_BYTES) {
          best = candidate;
          low = quality + 1;
        } else {
          high = quality - 1;
        }
      }
      return best;
    }
    edge = Math.floor(edge * 0.85);
  }

  const last = await encode(sourceBuffer, 48, 1);
  if (last.buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Could not compress image below ${MAX_IMAGE_BYTES} bytes`);
  }
  return last;
}

async function encode(sourceBuffer, edge, quality) {
  const { data, info } = await sharp(sourceBuffer, { animated: false, limitInputPixels: 100_000_000 })
    .rotate()
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 6, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

function dedupeImages(images) {
  const seen = new Set();
  const result = [];
  for (const [index, value] of (images || []).entries()) {
    const originalUrl = typeof value === 'string' ? value : value?.originalUrl;
    if (!originalUrl || seen.has(originalUrl)) continue;
    seen.add(originalUrl);
    result.push({
      position: value?.position ?? index,
      kind: value?.kind ?? 'photo',
      originalUrl,
    });
  }
  return result.sort((a, b) => a.position - b.position);
}
