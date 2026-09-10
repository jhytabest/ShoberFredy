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
      `SELECT l.*, a.data AS attributes_json
       FROM listings l JOIN listing_attributes a ON a.listing_id = l.id
       LEFT JOIN listing_verdicts v ON v.listing_id = l.id AND v.job_id = @jobId
       WHERE (v.job_id IS NOT NULL OR EXISTS (SELECT 1 FROM listing_sources s WHERE s.listing_id = l.id AND s.job_id = @jobId))
         AND (v.config_hash IS NULL OR v.config_hash != @hash OR a.parsed_at > v.decided_at)
       ORDER BY COALESCE(v.decided_at, 0), l.created_at LIMIT @limit`,
    )
    .all({ jobId: job.id, hash: filterConfigHash(job), limit });
  db.transaction(() => {
    for (const row of rows) {
      const result = decideListing(db, row, job);
      if (result.accepted && job.enabled) enqueueNotification(row.id, job, row.provider);
    }
  })();
  return rows.length;
}
