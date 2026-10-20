/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { sha256 } from '../../shared/hash.js';
import { FILTER_VERSION } from './listingFilters.js';
import { normalizeAttributes } from '../listings/standardizedFacts.js';

export function filterConfigHash(filters) { return sha256(JSON.stringify({ version: FILTER_VERSION, filters })); }
// Only features consumed by filtering participate in the decision fingerprint.
export function featureHash(listing) {
  const a = normalizeAttributes(listing.attributes);
  return sha256(JSON.stringify({
    size: listing.size ?? null,
    coldRentEur: a.coldRentEur ?? null,
    offerKind: a.offerKind ?? 'unknown',
    unitKind: a.unitKind ?? 'unknown',
    rentalArrangement: a.rentalArrangement ?? 'unknown',
    leaseDuration: a.leaseDuration ?? 'unstated',
    furnishingStatus: a.furnishingStatus ?? 'unknown',
    nonAltbau: a.amenitiesAbsent?.includes('old_building') ?? false,
    latitude: listing.latitude ?? null,
    longitude: listing.longitude ?? null,
    accuracy: listing.geocodeAccuracy ?? null,
  }));
}
export function recordVerdict(db, listing, filters, reasons) {
  const configHash = filterConfigHash(filters);
  const hash = featureHash(listing);
  const verdict = reasons.length ? 'rejected' : 'accepted';
  const previous = db.prepare('SELECT * FROM listing_decisions WHERE listing_id = ?').get(listing.id);
  db.prepare(`INSERT INTO listing_decisions (listing_id, verdict, reasons_json, config_hash, feature_hash, decided_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(listing_id) DO UPDATE SET verdict=excluded.verdict,
    reasons_json=excluded.reasons_json, config_hash=excluded.config_hash, feature_hash=excluded.feature_hash, decided_at=excluded.decided_at`)
    .run(listing.id, verdict, JSON.stringify(reasons), configHash, hash, Date.now());
  if (!previous || previous.config_hash !== configHash || previous.feature_hash !== hash)
    db.prepare(`INSERT INTO pipeline_audit_events (listing_id, stage, action, payload_json, created_at) VALUES (?, 'decision', ?, ?, ?)`)
      .run(listing.id, verdict, JSON.stringify({ filterVersion: FILTER_VERSION, configHash, reasons }), Date.now());
  return { accepted: !reasons.length, reasons };
}
export function notificationSettled(db, listingId, chatId, topicId = 0) {
  return Boolean(db.prepare(`SELECT 1 FROM notification_suppressions WHERE listing_id = ?
    UNION ALL SELECT 1 FROM notification_receipts WHERE listing_id = ? AND chat_id = ? AND topic_id = ? LIMIT 1`)
    .get(listingId, listingId, chatId, topicId));
}
