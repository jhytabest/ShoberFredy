/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { sha256 } from '../../shared/hash.js';
import { FILTER_VERSION } from './listingFilters.js';

export const ACCEPTED_SQL = (listing = 'l') => `EXISTS (SELECT 1 FROM listing_decisions d WHERE d.listing_id = ${listing}.id AND d.verdict = 'accepted')`;
export function filterConfigHash(filters) { return sha256(JSON.stringify({ version: FILTER_VERSION, filters })); }
export function featureHash(listing) {
  return sha256(JSON.stringify({ size: listing.size ?? null, latitude: listing.latitude ?? null,
    longitude: listing.longitude ?? null, accuracy: listing.geocodeAccuracy ?? null, attributes: listing.attributes }));
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
