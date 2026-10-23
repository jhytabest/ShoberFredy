/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { claimsForListing, resolveClaims, vetoes } from './claims.js';
import { visualFingerprint, matchFingerprints } from './visualFingerprint.js';

export async function findVisualMatches(db, listing, queueId, { signal } = {}) {
  if (!(listing.size > 0)) return [];
  // Strong identities already settle the match; avoid unrelated media work.
  if (resolveClaims(db, claimsForListing(listing)).some((m) => m.listing_id && ['src', 'pid', 'url'].includes(m.kind))) return [];
  const candidates = db.prepare(`SELECT l.*, json_extract(a.data,'$.floor') AS floor,
      json_extract(a.data,'$.priceType') AS price_basis FROM listings l
    LEFT JOIN listing_attributes a ON a.listing_id=l.id
    WHERE l.size BETWEEN ? AND ? AND l.representative_queue_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM listing_images i WHERE i.queue_id=l.representative_queue_id
        AND i.kind='photo' AND (i.visual_hash IS NOT NULL OR i.download_status='stored'))`)
    .all(Math.max(listing.size - 1, listing.size * 0.99), Math.min(listing.size + 1, listing.size / 0.99))
    .filter((row) => !vetoes(listing, { ...row, kind: 'visual', sharedImages: 2 }));
  if (!candidates.length) return [];
  const incoming = await fingerprints(db, queueId, signal);
  if (incoming.length < 2) return [];
  const matches = [];
  for (const row of candidates) {
    signal?.throwIfAborted();
    const imageMatches = matchFingerprints(incoming, await fingerprints(db, row.representative_queue_id, signal));
    if (imageMatches.length >= 2) matches.push({
      listing_id: row.id, kind: 'visual', claim: 'visual:dhash64-v1',
      sharedImages: imageMatches.length, imageMatches, queueId: row.representative_queue_id,
    });
  }
  return matches;
}

async function fingerprints(db, queueId, signal) {
  const rows = db.prepare(`SELECT id,content_hash,visual_hash,storage_path,download_status FROM listing_images
    WHERE queue_id=? AND kind='photo' AND content_hash IS NOT NULL ORDER BY position`).all(queueId);
  for (const row of rows) {
    signal?.throwIfAborted();
    if (row.visual_hash || row.download_status !== 'stored' || !row.storage_path) continue;
    // Older retained media is fingerprinted only for compatible candidates,
    // never in a migration/backfill or by re-fetching an advert.
    try {
      row.visual_hash = await visualFingerprint(row.storage_path);
      signal?.throwIfAborted();
      if (row.visual_hash) db.prepare('UPDATE listing_images SET visual_hash=? WHERE id=? AND content_hash=?')
        .run(row.visual_hash, row.id, row.content_hash);
    } catch (error) { signal?.throwIfAborted(); /* Missing/expired media supplies no match evidence. */ }
  }
  return rows.filter((row) => row.visual_hash);
}
