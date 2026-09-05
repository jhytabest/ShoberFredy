/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { listingAttributes } from '../listings/attributes.js';
import { recordListingAudit } from './sourceAudit.js';
import { alreadyNotified } from './terminalVerdict.js';
import { cancelWork, completeWork, enqueueWork, retryWork } from './workQueue.js';
import { env } from '../../shared/env.js';

export function enqueueNotification(listingId, job, provider) {
  if (!listingId || !job?.id) return undefined;
  if (alreadyNotified(SqliteConnection.getConnection(), listingId, job.id)) {
    return { inserted: 0, suppressed: 1 };
  }
  const db = SqliteConnection.getConnection();
  const legacy = db
    .prepare(`SELECT status, payload_json FROM pipeline_work WHERE kind = 'notify' AND key = ?`)
    .get(listingId);
  if (
    legacy &&
    JSON.parse(legacy.payload_json).jobId === job.id &&
    ['pending', 'processing', 'retry', 'deferred'].includes(legacy.status)
  )
    return { inserted: 0, suppressed: 1 };
  const key = JSON.stringify([job.id, listingId]);
  const previous = db
    .prepare(`SELECT status, outcome_code FROM pipeline_work WHERE kind = 'notify' AND key = ?`)
    .get(key);
  const revive =
    previous?.status === 'cancelled' &&
    ['listing_hidden', 'job_disabled', 'adapter_removed'].includes(previous.outcome_code);
  const enqueued = enqueueWork(
    'notify',
    key,
    { listingId, jobId: job.id, provider },
    { mode: revive ? 'reset' : 'ignore' },
  );
  if (!enqueued.changed) return { inserted: 0, suppressed: 0 };

  recordListingAudit(listingId, {
    stage: 'notification',
    action: 'enqueued',
    payload: { provider, jobId: job.id },
  });
  return { inserted: 1, suppressed: 0 };
}

export function deliveriesForKeys(keys) {
  if (!keys.length) return [];
  const placeholders = keys.map(() => '?').join(',');
  return SqliteConnection.getConnection()
    .prepare(
      `SELECT l.*, w.key AS delivery_key, w.attempt_count AS delivery_attempts,
              EXISTS (SELECT 1 FROM listing_verdicts v WHERE v.listing_id = l.id AND v.job_id = json_extract(w.payload_json, '$.jobId') AND v.verdict = 'accepted') AS accepted,
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
       JOIN listings l ON l.id = COALESCE(json_extract(w.payload_json, '$.listingId'), w.key)
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
    auditDelivery(
      listingId,
      result.status === 'dead' ? 'failed' : 'retry',
      String(error?.message || error).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]'),
    );
  }
}

function auditDelivery(key, action, reason = null) {
  const payload = SqliteConnection.getConnection()
    .prepare(`SELECT payload_json FROM pipeline_work WHERE kind = 'notify' AND key = ?`)
    .pluck()
    .get(key);
  const listingId = payload ? (JSON.parse(payload).listingId ?? key) : key;
  recordListingAudit(listingId, { queueId: key, stage: 'notification', action, reason });
}
