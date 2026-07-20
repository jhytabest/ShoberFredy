/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Remove obsolete text-dedupe keys and reassert terminal queue state. */
export function up(db) {
  const now = Date.now();
  const sources = db.prepare('SELECT id, dedupe_keys_json FROM listing_sources').all();
  const updateKeys = db.prepare('UPDATE listing_sources SET dedupe_keys_json = ? WHERE id = ?');
  let removedTextKeys = 0;
  for (const source of sources) {
    const keys = parseArray(source.dedupe_keys_json);
    const cleaned = [
      ...new Set(
        keys
          .filter((key) => {
            const keep = typeof key === 'string' && !key.startsWith('text:');
            if (!keep && typeof key === 'string' && key.startsWith('text:')) removedTextKeys++;
            return keep;
          })
          .map((key) => (key.startsWith('url:') ? `url:${canonicalUrl(key.slice(4))}` : key)),
      ),
    ].filter((key) => key !== 'url:');
    if (JSON.stringify(cleaned) !== JSON.stringify(keys)) updateKeys.run(JSON.stringify(cleaned), source.id);
  }

  const cancelledDetails = db
    .prepare(
      `UPDATE detail_fetch_queue
       SET status = 'cancelled', lease_until = NULL, completed_at = ?, updated_at = ?,
           last_error = 'Listing is terminally hidden'
       WHERE status IN ('pending', 'retry', 'processing') AND id IN (
         SELECT s.detail_queue_id FROM listing_sources s JOIN listings l ON l.id = s.listing_id
         WHERE l.manually_deleted = 1 AND s.detail_queue_id IS NOT NULL
       )`,
    )
    .run(now, now).changes;
  const cancelledParsing = db
    .prepare(
      `UPDATE parsing_queue
       SET status = 'cancelled', lease_until = NULL, completed_at = ?, updated_at = ?,
           last_error = 'Listing is terminally hidden'
       WHERE status IN ('pending', 'retry', 'processing') AND (
         listing_id IN (SELECT id FROM listings WHERE manually_deleted = 1)
         OR id IN (
           SELECT s.parsing_queue_id FROM listing_sources s JOIN listings l ON l.id = s.listing_id
           WHERE l.manually_deleted = 1 AND s.parsing_queue_id IS NOT NULL
         )
       )`,
    )
    .run(now, now).changes;
  db.prepare(
    `UPDATE rating_queue SET status = 'cancelled', lease_until = NULL, completed_at = ?, updated_at = ?,
     last_error = 'Listing is terminally hidden'
     WHERE listing_id IN (SELECT id FROM listings WHERE manually_deleted = 1)`,
  ).run(now, now);
  db.prepare(
    `UPDATE notification_deliveries SET status = 'cancelled', last_error = 'Listing is terminally hidden'
     WHERE status = 'pending' AND listing_id IN (SELECT id FROM listings WHERE manually_deleted = 1)`,
  ).run();
  db.prepare(
    `INSERT INTO pipeline_audit_events (
       source_id, listing_id, queue_id, stage, action, reason, payload_json, created_at
     ) VALUES (NULL, NULL, NULL, 'migration_repair', 'terminal_state_reasserted',
       'Removed obsolete text dedupe and cancelled hidden work', ?, ?)`,
  ).run(JSON.stringify({ removedTextKeys, cancelledDetails, cancelledParsing }), now);
}

function canonicalUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    if (/^(?:www\.)?wg-gesucht\.de$/iu.test(url.hostname) && url.searchParams.has('asset_id')) {
      const assetId = url.searchParams.get('asset_id');
      url.search = '';
      url.searchParams.set('asset_id', assetId);
      return url.toString().replace(/\/$/, '');
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|ref|referrer|tracking|trackingId)$/iu.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value).trim();
  }
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
