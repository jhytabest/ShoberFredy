/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import {
  CanonicalFacts,
  canonicalFilterReasons,
  primaryFilterReason,
  primaryFilterTerm,
} from '../pipeline/listingFilters.js';
import { listingAttributes } from '../listings/attributes.js';
import { filterConfigHash, recordVerdict } from '../pipeline/terminalVerdict.js';
import { enqueueNotification } from '../pipeline/notificationOutbox.js';

export function decideListing(db, listing, job) {
  const attributes = listing.attributes ?? listingAttributes(listing);
  const facts = new CanonicalFacts({ ...listing, attributes });
  const reasons = canonicalFilterReasons(facts, job);
  const reason = primaryFilterReason(reasons);
  recordVerdict(db, {
    listingId: listing.id,
    jobId: job.id,
    verdict: reason ? 'rejected' : 'accepted',
    reason,
    reasonTerm: primaryFilterTerm(reasons),
    stage: 'extraction',
    configHash: filterConfigHash(job),
    reasons,
    facts,
  });
  return { accepted: !reason, reasons };
}

export function reevaluateJobListings(db, job, limit = 100) {
  const rows = db
    .prepare(
      `SELECT DISTINCT l.*, a.data AS attributes_json
    FROM listing_sources s JOIN listings l ON l.id = s.listing_id
    JOIN listing_attributes a ON a.listing_id = l.id
    LEFT JOIN listing_verdicts v ON v.listing_id = l.id AND v.job_id = s.job_id
    WHERE s.job_id = ? AND l.state = 'active' AND (v.config_hash IS NULL OR v.config_hash != ? OR a.parsed_at > v.decided_at)
    ORDER BY l.created_at DESC LIMIT ?`,
    )
    .all(job.id, filterConfigHash(job), limit);
  for (const row of rows) {
    const result = decideListing(db, row, job);
    if (result.accepted) enqueueNotification(row.id, job, row.provider);
  }
  return rows.length;
}
