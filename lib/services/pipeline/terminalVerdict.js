/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import SqliteConnection from '../storage/SqliteConnection.js';
import { resolveClaims } from '../listings/claims.js';

/*
 * One place that answers "have we already decided about this advert?".
 *
 * Every stage used to answer it for itself, from whatever it happened to have.
 * Discovery compared the detail work row's status and last error; rating read
 * `hidden_reason` off the listing; the parser did not ask at all. So a verdict
 * that needed more than the search card — an area rejection after geocoding, an
 * intent rejection after extraction — left the detail item looking undecided,
 * and the next capture whose page text differed by a sidebar minted a new parse
 * key and bought the same answer again. One advert with a single source URL
 * collected twenty-six LLM calls that way, each one re-deriving the same
 * `area_filter`; across the corpus, 2,704 of 3,994 calls spent on rejected
 * listings were re-derivations.
 *
 * The gate is deliberately not a boolean. "Already rejected" is too strong: a
 * listing refused for being too small must be reconsidered when its card says a
 * new size, and one refused for being a sublet must not be reconsidered because
 * the page gained a cookie banner. So a verdict records three things beyond the
 * reason:
 *
 *   tier          which evidence decided it — a card, a geocode, or the LLM
 *   config_hash   the job configuration it was decided under
 *   evidence_hash the evidence itself, for the tiers whose evidence is cheap
 *
 * and a stage may only skip work when its own tier is no stronger than the tier
 * that decided, under the same configuration, on evidence that has not moved.
 */

/** Tier strength. A decision made on richer evidence outranks a cheaper one. */
const TIER_RANK = { card: 0, geo: 1, llm: 2 };

/**
 * The configuration a verdict was reached under.
 *
 * Only the parts a filter actually reads. Widening the blacklist, moving a
 * polygon or changing a specification changes the hash, which reopens every
 * verdict decided under the old one exactly once — the one property the
 * short-circuit this replaces got right, and the reason a bare "is it rejected"
 * flag would be wrong.
 *
 * It is per job, so two jobs that differ only in their polygons hold different
 * hashes and neither inherits the other's answer. That is what makes one shared
 * extraction safe to filter three times.
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
 * The evidence a card-tier verdict was reached from.
 *
 * Deliberately not the discovery hash. That covers the whole card — image URL,
 * description whitespace, the portal's own re-rendered id — and it is precisely
 * that drift which reopened settled adverts every fifteen minutes. Only the
 * fields a card filter can read belong here.
 *
 * @param {import('./stageFacts.js').CardFacts} facts
 * @returns {string}
 */
export function cardEvidenceHash(facts) {
  return sha256({
    title: facts?.cardTitle ?? null,
    description: facts?.cardDescription ?? null,
    address: facts?.cardAddress ?? null,
    price: facts?.cardPrice ?? null,
    size: facts?.cardSize ?? null,
    rooms: facts?.cardRooms ?? null,
  });
}

/**
 * The evidence a geo-tier verdict was reached from: the address that was
 * geocoded, and nothing else. Two captures of one advert differ in page text
 * constantly and in stated address almost never.
 *
 * @param {import('./stageFacts.js').GeoFacts} facts
 * @returns {string}
 */
export function geoEvidenceHash(facts) {
  return sha256({ address: facts?.geoAddress ?? null });
}

/**
 * Whether this advert is already terminally decided for this job, and may
 * therefore be skipped without spending anything.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} params
 * @param {({claim: string, kind: string})[]} params.claims identity claims of the advert
 * @param {object} params.job owning job, for the configuration hash
 * @param {'card'|'geo'|'llm'} params.tier the tier of the stage that is asking
 * @param {string|null} [params.evidenceHash] this stage's evidence, when it has any
 * @returns {{decided: boolean, listingId?: string|null, sourceId?: string|null,
 *            reason?: string, tier?: string}}
 */
export function terminalVerdict(db, { claims, job, tier, evidenceHash = null }) {
  const matches = resolveClaims(db, claims).filter(({ kind }) => IDENTITY_KINDS.has(kind));
  if (!matches.length) return { decided: false };

  const configHash = filterConfigHash(job);
  const listingIds = [...new Set(matches.map((match) => match.listing_id).filter(Boolean))];
  const sourceIds = [...new Set(matches.map((match) => match.source_id).filter(Boolean))];

  // A rejection that never became a listing is the cheapest answer available and
  // the one the old code could not represent at all, so it is asked first.
  for (const sourceId of sourceIds) {
    const row = db.prepare(`SELECT * FROM source_rejections WHERE source_id = ?`).get(sourceId);
    if (stillApplies(row, { configHash, tier, evidenceHash })) {
      return { decided: true, listingId: null, sourceId, reason: row.reason, tier: row.tier };
    }
  }

  for (const listingId of listingIds) {
    const row = db
      .prepare(`SELECT * FROM listing_verdicts WHERE listing_id = ? AND job_id = ? AND verdict = 'rejected'`)
      .get(listingId, job.id);
    if (stillApplies(row, { configHash, tier, evidenceHash })) {
      return { decided: true, listingId, sourceId: null, reason: row.reason, tier: row.tier };
    }
  }

  // Known advert, no verdict that binds this stage. The listing id is still worth
  // returning: the caller can attach to it instead of creating a second row.
  return { decided: false, listingId: listingIds[0] ?? null, sourceId: sourceIds[0] ?? null };
}

/**
 * Whether a stored verdict binds the stage that is asking.
 *
 * Three conditions, and every one of them has a failure behind it:
 *
 *   origin      a migrated verdict is history, not a decision. The conversion
 *               inherited whatever answer the old single-verdict schema happened
 *               to hold, which for two of three jobs was never their own. Acting
 *               on it would cement the bug the conversion exists to remove.
 *   config      a verdict reached under a different configuration says nothing
 *               about this one.
 *   tier        a decision made on richer evidence than the asker has still
 *               binds — the LLM's answer about a sublet does not stop applying
 *               because a card changed. A decision made on evidence the asker
 *               can see must be rechecked against it.
 */
function stillApplies(row, { configHash, tier, evidenceHash }) {
  if (!row) return false;
  if (row.origin !== 'live') return false;
  if (row.config_hash !== configHash) return false;
  if (TIER_RANK[row.tier] > TIER_RANK[tier]) return true;
  // Same tier or weaker: the asker can see this evidence, so it has to match.
  // A verdict with no recorded evidence cannot be confirmed and is not trusted.
  return Boolean(row.evidence_hash) && row.evidence_hash === evidenceHash;
}

/** Claim kinds that prove sameness rather than resemblance. */
const IDENTITY_KINDS = new Set(['cap', 'src', 'pid', 'url']);

/**
 * Record a job's verdict about a listing. Idempotent per (listing, job): a later
 * capture replaces the stored answer rather than adding a second one.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} params
 * @returns {void}
 */
export function recordVerdict(
  db,
  { listingId, jobId, verdict, reason = null, stage, tier, configHash, evidenceHash = null, now = Date.now() },
) {
  db.prepare(
    `INSERT INTO listing_verdicts
       (listing_id, job_id, verdict, reason, stage, tier, config_hash, evidence_hash, origin, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', ?)
     ON CONFLICT(listing_id, job_id) DO UPDATE SET
       verdict = excluded.verdict, reason = excluded.reason, stage = excluded.stage,
       tier = excluded.tier, config_hash = excluded.config_hash,
       evidence_hash = excluded.evidence_hash, origin = 'live', decided_at = excluded.decided_at`,
  ).run(listingId, jobId, verdict, verdict === 'rejected' ? reason : null, stage, tier, configHash, evidenceHash, now);
}

/**
 * Whether any job has accepted this listing. This is the polarity the rest of
 * the system reads, and the direction matters: a missing answer must mean "not
 * accepted", so that forgetting to ask costs a duplicate notification rather
 * than silencing a listing the user can see.
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
 * Mark the notification for this listing as delivered on the accepting job's
 * verdict.
 *
 * Delivery used to be remembered only by the notify work row, which scheduled
 * maintenance prunes after thirty days — so an advert still live on day
 * thirty-one was announced a second time. A verdict is not transient state and
 * does not get pruned.
 *
 * @param {string} listingId
 * @param {string} jobId
 * @returns {void}
 */
export function markVerdictNotified(listingId, jobId) {
  SqliteConnection.getConnection()
    .prepare(`UPDATE listing_verdicts SET notified_at = ? WHERE listing_id = ? AND job_id = ?`)
    .run(Date.now(), listingId, jobId);
}

/**
 * Whether this listing has already been announced, for any job. One flat is one
 * message: three overlapping searches over one Telegram chat should not produce
 * three copies of the same advert.
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

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
