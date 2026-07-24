/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { collectListingAuditBundle, compressAuditBundle } from './listingAuditBundle.js';

/**
 * Atomically preserve a complete compressed audit bundle and remove the true
 * legacy row from the production pipeline graph. This is intentionally only
 * callable by the historical reconciliation tool; live filter rejects remain
 * normal production listings.
 */
export function archivePreLlmListing(db, listingId, { runId, reason, classification }) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT listing_id FROM pre_llm_archive_listings WHERE listing_id = ?').get(listingId);
    if (existing) {
      if (db.prepare('SELECT 1 FROM listings WHERE id = ?').get(listingId)) {
        removeProductionGraph(db, listingId);
      }
      return { listingId, alreadyArchived: true };
    }

    const bundle = collectListingAuditBundle(db, listingId);
    const packed = compressAuditBundle(bundle);
    const now = Date.now();
    db.prepare(
      `INSERT INTO pre_llm_archive_listings (
         listing_id, run_id, archive_version, reason, geo_state, geo_precision,
         classification_json, payload_gzip, payload_sha256, payload_bytes,
         compressed_bytes, archived_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      listingId,
      runId,
      reason,
      classification?.geoState ?? null,
      classification?.geoPrecision ?? null,
      JSON.stringify(classification || {}),
      packed.compressed,
      packed.sha256,
      packed.payloadBytes,
      packed.compressedBytes,
      now,
    );
    removeProductionGraph(db, listingId, bundle);
    return {
      listingId,
      alreadyArchived: false,
      payloadBytes: packed.payloadBytes,
      compressedBytes: packed.compressedBytes,
    };
  })();
}

function removeProductionGraph(db, listingId, suppliedBundle = null) {
  const bundle = suppliedBundle || collectListingAuditBundle(db, listingId);
  const sourceIds = bundle.relations.sourceIds;
  const detailQueueIds = bundle.relations.detailQueueIds;
  const ownedQueueIds = bundle.tables.parsing_queue
    .filter((queue) => queue.listing_id == null || queue.listing_id === listingId)
    .map(({ id }) => id);
  const sourceIdsJson = JSON.stringify(sourceIds);
  const ownedQueueIdsJson = JSON.stringify(ownedQueueIds);

  // Tables without listing foreign keys are explicitly cleaned. Their full
  // original rows are already present in the compressed archive payload.
  db.prepare(
    `DELETE FROM pipeline_audit_events
     WHERE listing_id = ?
        OR source_id IN (SELECT value FROM json_each(?))
        OR (
          listing_id IS NULL AND source_id IS NULL
          AND queue_id IN (SELECT value FROM json_each(?))
        )`,
  ).run(listingId, sourceIdsJson, ownedQueueIdsJson);
  db.prepare(
    `DELETE FROM llm_call_audit
     WHERE listing_id = ?
        OR (listing_id IS NULL AND queue_id IN (SELECT value FROM json_each(?)))`,
  ).run(listingId, ownedQueueIdsJson);
  deleteIfPresent(db, 'homeserver_listing_scores', listingId);
  deleteIfPresent(db, 'homeserver_listing_model_scores', listingId);

  db.prepare(`DELETE FROM listing_sources WHERE id IN (SELECT value FROM json_each(?))`).run(sourceIdsJson);
  db.prepare('DELETE FROM listings WHERE id = ?').run(listingId);

  // A historical source can own a queue without the old queue having a
  // listing_id. Remove it only after proving that no production source still
  // refers to it.
  db.prepare(
    `DELETE FROM parsing_queue
     WHERE id IN (SELECT value FROM json_each(?))
       AND NOT EXISTS (
         SELECT 1 FROM listing_sources source
         WHERE source.parsing_queue_id = parsing_queue.id
       )`,
  ).run(ownedQueueIdsJson);
  db.prepare(
    `DELETE FROM detail_fetch_queue
     WHERE id IN (SELECT value FROM json_each(?))
       AND NOT EXISTS (
         SELECT 1 FROM listing_sources source
         WHERE source.detail_queue_id = detail_fetch_queue.id
       )`,
  ).run(JSON.stringify(detailQueueIds));
}

function deleteIfPresent(db, table, listingId) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (exists) db.prepare(`DELETE FROM ${table} WHERE listing_id = ?`).run(listingId);
}
