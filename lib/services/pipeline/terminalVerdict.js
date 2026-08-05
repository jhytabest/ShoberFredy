/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import SqliteConnection from '../storage/SqliteConnection.js';
import { resolveClaims } from '../listings/claims.js';

/*
 * One question, asked by every stage before it spends anything: have we already
 * decided about this advert, for this job, on evidence that has not changed?
 *
 * Each stage used to answer it for itself, from whatever it had. Discovery
 * compared a work row's status and last error; rating read a column off the
 * listing; the parser did not ask at all. So a verdict that needed more than the
 * search card left the advert looking undecided, and the next capture whose page
 * text differed by a sidebar minted a new key and bought the same answer again.
 * One advert with a single source URL collected twenty-six LLM calls that way.
 *
 * A verdict therefore records not just the reason but what it was decided from:
 *
 *   config_hash    the job configuration. Widening a blacklist or moving a
 *                  polygon changes it and reopens everything once, which is the
 *                  one property a bare "is it rejected" flag cannot have.
 *   evidence_kind  'card', 'geo', or 'final'
 *   evidence_hash  the evidence itself, for the two kinds that are cheap
 *
 * A caller offers whatever evidence it can compute. Evidence it can compute is
 * rechecked; evidence it cannot is trusted. `final` is never rechecked — a
 * verdict from the extraction cannot be revisited by anything cheaper than
 * another extraction, and re-extracting because a page gained a cookie banner is
 * the whole problem this replaces.
 */

/**
 * The configuration a verdict was reached under. Per job, so two jobs that
 * differ only in their polygons hold different hashes and neither inherits the
 * other's answer — which is what makes one shared extraction safe to filter
 * three times.
 *
 * @param {{blacklist?: string[], specFilter?: object, spatialFilter?: object}} job
 * @returns {string}
 */
export function filterConfigHash(job) {
  return sha256({
    blacklist: [...(job?.blacklist || [])].sort(),
    specFilter: job?.specFilter ?? null,
    spatialFilter: job?.spatialFilter ?? null,
  });
}

/**
 * The evidence a card verdict was reached from.
 *
 * Deliberately not the discovery hash: that covers the whole card, including the
 * image URL and the portal's own re-rendered id, and it is precisely that drift
 * which reopened settled adverts every fifteen minutes.
 *
 * @param {import('./listingFilters.js').CardFacts} facts
 * @returns {string}
 */
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

/**
 * Whether this advert is already terminally decided for this job.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} params
 * @param {({claim: string, kind: string})[]} params.claims identity claims of the advert
 * @param {object} params.job
 * @param {{card?: string, geo?: string}} [params.evidence] what this caller can recheck
 * @returns {{decided: boolean, listingId: string|null, sourceId: string|null, reason?: string}}
 */
export function terminalVerdict(db, { claims, job, evidence = {} }) {
  const matches = resolveClaims(db, claims).filter(({ kind }) => IDENTITY_KINDS.has(kind));
  if (!matches.length) return { decided: false, listingId: null, sourceId: null };

  const configHash = filterConfigHash(job);
  const listingIds = [...new Set(matches.map((m) => m.listing_id).filter(Boolean))];
  const sourceIds = [...new Set(matches.map((m) => m.source_id).filter(Boolean))];

  // A rejection that never became a listing is the cheapest answer there is, and
  // the one the old schema could not represent at all. Asked first.
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

  // Known advert, nothing that binds. The listing id is still worth returning:
  // the caller can attach to it rather than opening a second row.
  return { decided: false, listingId: listingIds[0] ?? null, sourceId: sourceIds[0] ?? null };
}

function binds(row, configHash, evidence) {
  if (!row || row.config_hash !== configHash) return false;
  const offered = evidence[row.evidence_kind];
  // Evidence this caller cannot compute is trusted; 'final' has none by design.
  return offered === undefined ? true : offered === row.evidence_hash;
}

/** Claim kinds that prove sameness rather than resemblance. */
const IDENTITY_KINDS = new Set(['cap', 'src', 'pid', 'url']);

/**
 * Record a job's answer about a listing. One row per (listing, job): a later
 * capture replaces the stored answer rather than adding a second one.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} params
 * @returns {void}
 */
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
  // A verdict is per job, but the configuration it was reached under is stored
  // with it, so a job whose filters change reopens only its own answers.
  db.prepare(`UPDATE listing_verdicts SET config_hash = ? WHERE listing_id = ? AND job_id = ?`).run(
    configHash,
    listingId,
    jobId,
  );
}

/**
 * Whether any job accepts this listing.
 *
 * Asked in the positive on purpose. When the flag was "hidden", a row read with
 * `SELECT *` that had lost the column produced `undefined`, every stored listing
 * looked visible, and a resemblance guess could silence one — with no error
 * anywhere. Asking whether a row is accepted makes a missing answer mean "not
 * accepted", so the same mistake costs a duplicate message instead.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} listingId
 * @returns {boolean}
 */
export function isAcceptedAnywhere(db, listingId) {
  return Boolean(
    db.prepare(`SELECT 1 FROM listing_verdicts WHERE listing_id = ? AND verdict = 'accepted' LIMIT 1`).get(listingId),
  );
}

/**
 * Whether this listing has already been announced, for any job. One flat is one
 * message: three overlapping searches over one Telegram chat should not produce
 * three copies.
 *
 * Durable, unlike the work row — terminal work is pruned after thirty days, so
 * an advert still live on day thirty-one used to be announced again.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} listingId
 * @returns {boolean}
 */
export function alreadyNotified(db, listingId) {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM listing_verdicts WHERE listing_id = ? AND notified_at IS NOT NULL LIMIT 1`)
      .get(listingId),
  );
}

/**
 * Record that this advert has been announced, for every job that accepted it.
 *
 * One message goes out per advert, not per job — nobody wants three Telegrams
 * for one flat — and `alreadyNotified` asks the question per listing to keep it
 * that way. But a verdict is per (listing, job), so marking only the job whose
 * enqueue happened to win left every other accepting job's verdict looking
 * unannounced forever. Live, that was eight accepted verdicts with a null
 * `notified_at` and no work left to produce one, three of them against a notify
 * row already marked sent.
 *
 * The suppression still worked, because it reads "any verdict for this listing".
 * The bookkeeping did not, and the bookkeeping is what a re-decision consults.
 *
 * @param {string} listingId
 * @returns {void}
 */
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
