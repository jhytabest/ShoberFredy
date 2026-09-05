/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { listingAttributes } from '../listings/attributes.js';
import { recordListingAudit } from './sourceAudit.js';
import { alreadyNotified, ACCEPTED_SQL } from './terminalVerdict.js';
import { cancelWork, completeWork, enqueueWork, retryWork } from './workQueue.js';
import { env } from '../../shared/env.js';

export function enqueueNotification(listingId, job, provider) {
  if (!listingId || !job?.id) return undefined;
  if (alreadyNotified(SqliteConnection.getConnection(), listingId)) {
    return { inserted: 0, suppressed: 1 };
  }
  const enqueued = enqueueWork('notify', listingId, { listingId, jobId: job.id, provider }, { mode: 'ignore' });
  if (!enqueued.changed) return { inserted: 0, suppressed: 0 };

  recordListingAudit(listingId, {
    stage: 'notification',
    action: 'enqueued',
    payload: { provider },
  });
  return { inserted: 1, suppressed: 0 };
}

export function deliveriesForKeys(keys) {
  if (!keys.length) return [];
  const placeholders = keys.map(() => '?').join(',');
  return SqliteConnection.getConnection()
    .prepare(
      `SELECT l.*, w.attempt_count AS delivery_attempts,
              ${ACCEPTED_SQL('l')} AS accepted,
              json_extract(w.payload_json, '$.jobId') AS job_id,
              json_extract(w.payload_json, '$.provider') AS provider,
              a.data AS attributes_json,
              (
                SELECT i.storage_path
                FROM listing_images i
                WHERE i.download_status = 'stored'
                  AND i.storage_path IS NOT NULL
                  AND (
                    i.listing_id = l.id
                    OR i.queue_id IN (
                      SELECT s.parsing_queue_id
                      FROM listing_sources s
                      WHERE s.listing_id = l.id AND s.parsing_queue_id IS NOT NULL
                    )
                  )
                ORDER BY CASE WHEN i.listing_id = l.id THEN 0 ELSE 1 END, i.position ASC
                LIMIT 1
              ) AS stored_image_path
       FROM pipeline_work w
       JOIN listings l ON l.id = w.key
       LEFT JOIN listing_attributes a ON a.listing_id = l.id
       WHERE w.kind = 'notify' AND w.key IN (${placeholders})
       ORDER BY job_id, provider, l.created_at`,
    )
    .all(...keys)
    .map((row) => ({ ...row, ...listingAttributes(row) }));
}

export function markDeliveriesSent(listingIds) {
  for (const listingId of listingIds) {
    completeWork('notify', listingId, { status: 'sent', action: 'sent', code: 'delivered' });
    auditDelivery(listingId, 'sent');
  }
}

export function markDeliveriesCancelled(listingIds, reason, code = 'listing_hidden') {
  for (const listingId of listingIds) {
    cancelWork('notify', listingId, reason, { code });
    auditDelivery(listingId, 'cancelled', reason);
  }
}

export function markDeliveriesFailed(listingIds, error) {
  for (const listingId of listingIds) {
    const result = retryWork('notify', listingId, error, {
      stage: 'notification',
      maxFailures: env('FREDY_NOTIFY_MAX_FAILURES'),
    });
    auditDelivery(listingId, result.status === 'dead' ? 'failed' : 'retry', String(error?.message || error));
  }
}

function auditDelivery(listingId, action, reason = null) {
  recordListingAudit(listingId, { queueId: listingId, stage: 'notification', action, reason });
}
