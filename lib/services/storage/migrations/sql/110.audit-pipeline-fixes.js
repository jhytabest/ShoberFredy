/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { createHash } from 'node:crypto';

export function up(db) {
  db.exec(`
    ALTER TABLE listing_images ADD COLUMN visual_hash TEXT;
    CREATE INDEX idx_listings_size ON listings(size);
    UPDATE pipeline_config SET filters_json=json_set(filters_json,'$.excludeNonRental',json('true'));
  `);
  // Repair only the current text of post-cutover listings from their retained
  // representative capture. This changes no facts, decisions, work or receipts.
  const captures = db.prepare(`SELECT l.id,l.representative_queue_id,p.body_json,o.observed_at,
      ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY o.observed_at DESC) AS latest
    FROM listings l JOIN listing_extractions e ON e.queue_id=l.representative_queue_id
    JOIN listing_sources s ON s.listing_id=l.id
    JOIN listing_source_observations o ON o.source_id=s.id AND o.stage='detail'
      AND o.content_hash=json_extract(e.llm_json,'$.provenance.evidenceHash')
    JOIN audit_payloads p ON p.sha256=o.payload_sha256 AND p.body_json IS NOT NULL
    WHERE l.created_at>=(SELECT cutover_at FROM pipeline_config WHERE id=1)`).all();
  const repair = db.prepare(`UPDATE listing_texts SET full_text=?,content_hash=?,captured_at=?
    WHERE listing_id=? AND full_text!=?`);
  const audit = db.prepare(`INSERT INTO pipeline_audit_events (listing_id,queue_id,stage,action,created_at)
    VALUES (?,?,'migration','representative_text_repaired',?)`);
  for (const row of captures) {
    if (row.latest !== 1) continue;
    const body = JSON.parse(row.body_json);
    const text = typeof body.fullText === 'string' ? body.fullText.trim() : '';
    if (text && repair.run(text, createHash('sha256').update(text).digest('hex'), row.observed_at, row.id, text).changes)
      audit.run(row.id,row.representative_queue_id,Date.now());
  }
}
