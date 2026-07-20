/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';

/**
 * Schema-v4 queue collapse found a handful of historical rows sharing one
 * stable source. Keep the rows as hidden audit history, but attach every URL
 * and source to the surviving canonical listing so no visible v0 orphan is
 * left behind.
 */
export function up(db) {
  const now = Date.now();
  const orphans = db
    .prepare(
      `SELECT l.*, q.id AS queue_id, q.last_error
       FROM listings l JOIN parsing_queue q ON q.listing_id = l.id
       WHERE l.manually_deleted = 0 AND l.canonical_schema_version < 4
         AND q.schema_version = 4 AND q.queue_kind = 'backfill' AND q.status = 'cancelled'
         AND q.last_error LIKE 'Superseded by stable source queue %'
         AND NOT EXISTS (
           SELECT 1 FROM parsing_queue active
           WHERE active.listing_id = l.id AND active.schema_version = 4
             AND active.queue_kind = 'backfill'
             AND active.status IN ('pending', 'retry', 'processing')
         )`,
    )
    .all();

  for (const orphan of orphans) {
    const survivorQueueId = orphan.last_error.slice('Superseded by stable source queue '.length).trim();
    const survivor = db
      .prepare(
        `SELECT q.listing_id, l.link, l.source_urls_json
         FROM parsing_queue q JOIN listings l ON l.id = q.listing_id
         WHERE q.id = ?`,
      )
      .get(survivorQueueId);
    if (!survivor?.listing_id || survivor.listing_id === orphan.id) continue;

    const sourceUrls = db.prepare('SELECT source_url FROM listing_sources WHERE listing_id = ?').all(orphan.id);
    const mergedUrls = unique([
      survivor.link,
      ...parseArray(survivor.source_urls_json),
      orphan.link,
      ...parseArray(orphan.source_urls_json),
      ...sourceUrls.map((row) => row.source_url),
    ]);
    db.prepare('UPDATE listings SET source_urls_json = ? WHERE id = ?').run(
      JSON.stringify(mergedUrls),
      survivor.listing_id,
    );
    db.prepare(
      `UPDATE listing_sources SET listing_id = ?, parsing_queue_id = ?,
       representative_source_id = COALESCE(representative_source_id, id), dedupe_stage = 'historical_final'
       WHERE listing_id = ?`,
    ).run(survivor.listing_id, survivorQueueId, orphan.id);
    db.prepare(
      `UPDATE listings SET manually_deleted = 1, hidden_reason = 'historical_duplicate',
       filter_reasons_json = ? WHERE id = ?`,
    ).run(JSON.stringify([{ code: 'historical_duplicate', stage: 'migration_repair' }]), orphan.id);
    db.prepare(
      `UPDATE rating_queue SET status = 'cancelled', lease_until = NULL, completed_at = ?, updated_at = ?,
       last_error = 'Merged into historical representative' WHERE listing_id = ?`,
    ).run(now, now, orphan.id);
    db.prepare(
      `UPDATE notification_deliveries SET status = 'cancelled', last_error = 'Merged into historical representative'
       WHERE listing_id = ? AND status = 'pending'`,
    ).run(orphan.id);
    db.prepare(
      `INSERT INTO pipeline_audit_events (
         source_id, listing_id, queue_id, stage, action, reason, payload_json, created_at
       ) VALUES (NULL, ?, ?, 'migration_repair', 'merged', 'Stable source already queued', ?, ?)`,
    ).run(survivor.listing_id, orphan.queue_id, JSON.stringify({ hiddenListingId: orphan.id, survivorQueueId }), now);
  }

  // Safety net for any unrelated v0 row whose only v4 attempt was terminal:
  // reactivate its own backfill rather than leaving a visible migration orphan.
  const remaining = db
    .prepare(
      `SELECT l.id, (
         SELECT q.id FROM parsing_queue q
         WHERE q.listing_id = l.id AND q.schema_version = 4 AND q.queue_kind = 'backfill'
         ORDER BY q.updated_at DESC LIMIT 1
       ) AS queue_id
       FROM listings l
       WHERE l.manually_deleted = 0 AND l.canonical_schema_version < 4
         AND NOT EXISTS (
           SELECT 1 FROM parsing_queue active
           WHERE active.listing_id = l.id AND active.schema_version = 4
             AND active.queue_kind = 'backfill'
             AND active.status IN ('pending', 'retry', 'processing')
         )`,
    )
    .all();
  for (const row of remaining) {
    if (row.queue_id) {
      const cached = db.prepare('SELECT llm_json FROM listing_extractions WHERE queue_id = ?').get(row.queue_id);
      db.prepare(
        `UPDATE parsing_queue SET status = 'pending', stage = ?, attempt_count = 0,
         lease_until = NULL, next_attempt_at = 0, last_error = NULL, completed_at = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(cached?.llm_json ? 'llm' : 'captured', now, row.queue_id);
      continue;
    }
    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(row.id);
    const capture = {
      provider: listing.provider,
      externalId: listing.hash || listing.id,
      sourceUrl: listing.link,
      discoveredAt: listing.created_at || now,
      rawText: listing.description || '',
      fullText: listing.description || '',
      embeddedData: [],
      images: [],
      evidenceStatus: 'historical_backfill',
    };
    db.prepare(
      `INSERT INTO parsing_queue (
         id, queue_kind, schema_version, job_id, provider, source_hash, listing_id,
         external_id, source_url, discovered_at, capture_json, stage, status, created_at, updated_at
       ) VALUES (?, 'backfill', 4, ?, ?, ?, ?, ?, ?, ?, ?, 'captured', 'pending', ?, ?)`,
    ).run(
      crypto.randomUUID(),
      listing.job_id,
      listing.provider,
      `${listing.hash || listing.id}:repair:${listing.id}`,
      listing.id,
      listing.hash || listing.id,
      listing.link,
      listing.created_at || now,
      JSON.stringify(capture),
      now,
      now,
    );
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

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}
