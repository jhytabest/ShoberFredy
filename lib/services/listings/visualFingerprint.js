/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import sharp from 'sharp';

const PREFIX = 'dhash64-v1:';
const MAX_DISTANCE = 6;

export async function visualFingerprint(input) {
  const pixels = await sharp(input, { limitInputPixels: 16_000_000 })
    .rotate().flatten({ background: '#ffffff' }).resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++)
    bits = (bits << 1n) | BigInt(pixels[y * 9 + x] > pixels[y * 9 + x + 1]);
  const ones = bitCount(bits);
  // Flat backgrounds and near-empty plans are poor identity evidence.
  return ones < 8 || ones > 56 ? null : `${PREFIX}${bits.toString(16).padStart(16, '0')}`;
}

export function fingerprintDistance(a, b) {
  if (!valid(a) || !valid(b)) return Infinity;
  return bitCount(BigInt(`0x${a.slice(PREFIX.length)}`) ^ BigInt(`0x${b.slice(PREFIX.length)}`));
}

// Count independent photographs once on each side, even if a portal supplies
// several resized/encoded copies of one photo.
export function matchFingerprints(left, right) {
  const distinct = (rows) => rows.filter((row, i) => valid(row.visual_hash) &&
    !rows.slice(0, i).some((previous) => fingerprintDistance(row.visual_hash, previous.visual_hash) <= MAX_DISTANCE));
  const a = distinct(left), b = distinct(right);
  const edges = a.map((image) => b.map((other, index) => ({ index, distance: fingerprintDistance(image.visual_hash, other.visual_hash) }))
    .filter((edge) => edge.distance <= MAX_DISTANCE).sort((x, y) => x.distance - y.distance));
  const owners = new Map();
  const assign = (i, seen) => {
    for (const edge of edges[i]) {
      if (seen.has(edge.index)) continue;
      seen.add(edge.index);
      if (!owners.has(edge.index) || assign(owners.get(edge.index), seen)) {
        owners.set(edge.index, i);
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < a.length; i++) assign(i, new Set());
  return [...owners].map(([j, i]) => ({
    incomingImage: a[i].id, candidateImage: b[j].id,
    incomingHash: a[i].visual_hash, candidateHash: b[j].visual_hash,
    distance: fingerprintDistance(a[i].visual_hash, b[j].visual_hash),
  }));
}

function valid(value) { return typeof value === 'string' && /^dhash64-v1:[a-f0-9]{16}$/u.test(value); }
function bitCount(value) { let n = 0; while (value) { value &= value - 1n; n++; } return n; }
