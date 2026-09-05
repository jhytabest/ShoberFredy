/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import SqliteConnection from '../storage/SqliteConnection.js';
import { resolveClaims } from '../listings/claims.js';

// Some job would have notified on this listing.
export const ACCEPTED_SQL = (listings = 'l') =>
  `EXISTS (SELECT 1 FROM listing_verdicts v
            WHERE v.listing_id = ${listings}.id AND v.verdict = 'accepted')`;

export function filterConfigHash(job) {
  return sha256({
    blacklist: [...(job?.blacklist || [])].sort(),
    intentFilter: [...(job?.intentFilter || [])].sort(),
    specFilter: job?.specFilter ?? null,
    spatialFilter: job?.spatialFilter ?? null,
  });
}

export function cardEvidence(facts) {
  return sha256([
    facts.cardTitle,
    facts.cardDescription,
    facts.cardAddress,
    facts.cardPrice,
    facts.cardSize,
    facts.cardRooms,
  ]);
}

export function terminalVerdict(db, { claims, job, evidence = {} }) {
  const matches = resolveClaims(db, claims).filter(({ kind }) => IDENTITY_KINDS.has(kind));
  if (!matches.length) return { decided: false, listingId: null, sourceId: null };

  const configHash = filterConfigHash(job);
  const listingIds = [...new Set(matches.map((m) => m.listing_id).filter(Boolean))];
  const sourceIds = [...new Set(matches.map((m) => m.source_id).filter(Boolean))];

  for (const sourceId of sourceIds) {
    const row = db.prepare(`SELECT * FROM source_rejections WHERE source_id = ?`).get(sourceId);
    if (binds(row, configHash, evidence)) {
      return { decided: true, listingId: null, sourceId, reason: row.reason };
    }
  }
  for (const listingId of listingIds) {
    const row = db
      .prepare(`SELECT * FROM listing_verdicts WHERE listing_id = ? AND job_id = ? AND verdict = 'rejected'`)
      .get(listingId, job.id);
    if (binds(row, configHash, evidence)) {
      return { decided: true, listingId, sourceId: null, reason: row.reason };
    }
  }

  return { decided: false, listingId: listingIds[0] ?? null, sourceId: sourceIds[0] ?? null };
}

function binds(row, configHash, evidence) {
  if (!row || row.config_hash !== configHash) return false;
  const offered = evidence[row.evidence_kind];
  return offered === undefined ? true : offered === row.evidence_hash;
}

const IDENTITY_KINDS = new Set(['cap', 'src', 'pid', 'url']);

export function recordVerdict(db, { listingId, jobId, verdict, reason = null, reasonTerm = null, stage, configHash }) {
  const rejected = verdict === 'rejected';
  db.prepare(
    `INSERT INTO listing_verdicts
       (listing_id, job_id, verdict, reason, reason_term, stage, evidence_kind, evidence_hash, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, 'final', NULL, ?)
     ON CONFLICT(listing_id, job_id) DO UPDATE SET
       verdict = excluded.verdict, reason = excluded.reason, reason_term = excluded.reason_term,
       stage = excluded.stage,
       evidence_kind = 'final', evidence_hash = NULL, decided_at = excluded.decided_at`,
  ).run(listingId, jobId, verdict, rejected ? reason : null, rejected ? reasonTerm : null, stage, Date.now());
  db.prepare(`UPDATE listing_verdicts SET config_hash = ? WHERE listing_id = ? AND job_id = ?`).run(
    configHash,
    listingId,
    jobId,
  );
}

export function isAcceptedAnywhere(db, listingId) {
  return Boolean(
    db.prepare(`SELECT 1 FROM listing_verdicts WHERE listing_id = ? AND verdict = 'accepted' LIMIT 1`).get(listingId),
  );
}

export function alreadyNotified(db, listingId) {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM listing_verdicts WHERE listing_id = ? AND notified_at IS NOT NULL LIMIT 1`)
      .get(listingId),
  );
}

export function markVerdictNotified(listingId) {
  SqliteConnection.getConnection()
    .prepare(
      `UPDATE listing_verdicts SET notified_at = ?
       WHERE listing_id = ? AND verdict = 'accepted' AND notified_at IS NULL`,
    )
    .run(Date.now(), listingId);
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
