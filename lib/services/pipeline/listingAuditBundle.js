/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';

/**
 * Collect every production row which belongs to, or directly explains, one
 * listing. The result is used before historical archival and before canonical
 * duplicate absorption, so destructive reconciliation never destroys audit
 * evidence.
 */
export function collectListingAuditBundle(db, listingId) {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
  if (!listing) throw new Error(`Listing '${listingId}' does not exist`);

  const sources = rows(db, 'SELECT * FROM listing_sources WHERE listing_id = ?', listingId);
  const sourceIds = sources.map(({ id }) => id);
  const detailQueueIds = unique(sources.map(({ detail_queue_id }) => detail_queue_id));
  const referencedParsingIds = unique(sources.map(({ parsing_queue_id }) => parsing_queue_id));
  const parsingQueues = rows(
    db,
    `SELECT * FROM parsing_queue
     WHERE listing_id = ?
        OR id IN (SELECT value FROM json_each(?))
     ORDER BY created_at`,
    listingId,
    JSON.stringify(referencedParsingIds),
  );
  const parsingQueueIds = unique(parsingQueues.map(({ id }) => id));

  return {
    bundleVersion: 1,
    capturedAt: Date.now(),
    listing,
    tables: {
      listing_attributes: rows(db, 'SELECT * FROM listing_attributes WHERE listing_id = ?', listingId),
      listing_sources: sources,
      listing_source_observations: rows(
        db,
        `SELECT * FROM listing_source_observations
         WHERE source_id IN (SELECT value FROM json_each(?))
         ORDER BY observed_at`,
        JSON.stringify(sourceIds),
      ),
      detail_fetch_queue: rows(
        db,
        `SELECT * FROM detail_fetch_queue
         WHERE id IN (SELECT value FROM json_each(?))
         ORDER BY created_at`,
        JSON.stringify(detailQueueIds),
      ),
      parsing_queue: parsingQueues,
      listing_extractions: rows(
        db,
        `SELECT * FROM listing_extractions
         WHERE listing_id = ?
            OR queue_id IN (SELECT value FROM json_each(?))`,
        listingId,
        JSON.stringify(parsingQueueIds),
      ),
      listing_images: rows(
        db,
        `SELECT * FROM listing_images
         WHERE listing_id = ?
            OR queue_id IN (SELECT value FROM json_each(?))
         ORDER BY queue_id, position`,
        listingId,
        JSON.stringify(parsingQueueIds),
      ),
      llm_call_audit: rows(
        db,
        `SELECT * FROM llm_call_audit
         WHERE listing_id = ?
            OR queue_id IN (SELECT value FROM json_each(?))
         ORDER BY started_at`,
        listingId,
        JSON.stringify(parsingQueueIds),
      ),
      processing_attempts: rows(
        db,
        `SELECT * FROM processing_attempts
         WHERE queue_id IN (SELECT value FROM json_each(?))
         ORDER BY started_at`,
        JSON.stringify(parsingQueueIds),
      ),
      pipeline_audit_events: rows(
        db,
        `SELECT * FROM pipeline_audit_events
         WHERE listing_id = ?
            OR source_id IN (SELECT value FROM json_each(?))
            OR queue_id IN (SELECT value FROM json_each(?))
         ORDER BY created_at, id`,
        listingId,
        JSON.stringify(sourceIds),
        JSON.stringify([...detailQueueIds, ...parsingQueueIds]),
      ),
      rating_queue: rows(db, 'SELECT * FROM rating_queue WHERE listing_id = ?', listingId),
      notification_deliveries: rows(
        db,
        'SELECT * FROM notification_deliveries WHERE listing_id = ? ORDER BY created_at',
        listingId,
      ),
      homeserver_listing_scores: rows(db, 'SELECT * FROM homeserver_listing_scores WHERE listing_id = ?', listingId),
      homeserver_listing_model_scores: rows(
        db,
        'SELECT * FROM homeserver_listing_model_scores WHERE listing_id = ? ORDER BY model_family',
        listingId,
      ),
    },
    relations: { sourceIds, detailQueueIds, parsingQueueIds },
  };
}

export function compressAuditBundle(bundle) {
  const payload = Buffer.from(JSON.stringify(bundle));
  const compressed = gzipSync(payload, { level: 9 });
  return {
    compressed,
    sha256: crypto.createHash('sha256').update(payload).digest('hex'),
    payloadBytes: payload.length,
    compressedBytes: compressed.length,
  };
}

function rows(db, sql, ...params) {
  const table = sql.match(/\bFROM\s+([a-z0-9_]+)/iu)?.[1];
  if (table && !tableExists(db, table)) return [];
  return db.prepare(sql).all(...params);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
