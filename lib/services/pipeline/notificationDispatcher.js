/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import * as telegram from '../../notification/adapter/telegram.js';
import { formatListing } from '../../utils/formatListing.js';
import { formatScoreLine } from '../scoring/marketScore.js';
import { listingFactsGerman } from '../../notification/listingLabels.js';
import { getJob } from '../storage/jobStorage.js';
import { markVerdictNotified } from './terminalVerdict.js';
import { env } from '../../shared/env.js';
import { registerHandler, startWorker } from './workQueue.js';
import {
  deliveriesForKeys,
  getListingScores,
  markDeliveriesCancelled,
  markDeliveriesFailed,
  markDeliveriesSent,
} from './notificationOutbox.js';

const WORKER_NAME = 'notify';

/**
 * Deliver rated listings, as an ordinary registered worker.
 *
 * It was not one. Notification ran on a bespoke setTimeout loop guarded by a
 * module-level boolean: no lease, no `processing` transition, no registration,
 * so it was invisible to getWorkerHealth and absent from `expectWorkers` — the
 * one worker whose silence the health endpoint could not report. A crash during
 * a Telegram send left its rows claimable again with no record that a partial
 * delivery might already have gone out.
 *
 * The unit of work is a group, not an item — a discovery run rates a burst of
 * listings and they go out as one digest per job and provider — which is why the
 * queue grew `claimWorkBatch`. Every member of a digest is claimed together
 * under one lease.
 *
 * @returns {string|null} worker name, or null when the kill switch is off
 */
export function startNotificationDispatcher() {
  registerHandler('notify', {
    name: WORKER_NAME,
    enabled: () => env('FREDY_NOTIFICATION_ENABLED'),
    timeoutMs: () => env('FREDY_NOTIFICATION_ITEM_TIMEOUT_MS'),
    maxAttempts: () => env('FREDY_NOTIFY_MAX_FAILURES'),
    batch: () => ({ limit: env('FREDY_NOTIFICATION_BATCH_SIZE'), groupBy: 'jobId' }),
    startedMessage: 'Notification dispatcher started.',
    handler: (item) => dispatchDeliveries(item.items ?? [item]),
  });
  return startWorker('notify');
}

async function dispatchDeliveries(items) {
  {
    const rows = deliveriesForKeys(items.map((item) => item.key));
    const scores = getListingScores([...new Set(rows.map((row) => row.id))]);
    // One digest per job and provider. A discovery run finishes rating a burst
    // of listings at once, and a burst is what a digest is for; grouping by
    // provider as well keeps the message header honest about where the adverts
    // came from.
    for (const group of groupDeliveries(rows).values()) {
      const listingIds = group.rows.map((row) => row.id);
      const job = getJob(group.jobId);
      if (!job?.enabled) {
        markDeliveriesCancelled(listingIds, 'Job disabled before notification delivery', 'job_disabled');
        continue;
      }
      // Telegram is the only destination, but it is still configured per job,
      // and a job whose configuration was removed has nowhere to deliver to.
      const adapter = job.notificationAdapter?.find((entry) => entry?.id === telegram.config.id);
      if (!adapter) {
        markDeliveriesCancelled(
          listingIds,
          'Telegram configuration removed from the job before delivery',
          'adapter_removed',
        );
        continue;
      }
      // Visibility is re-checked here, not at enqueue time: a listing can be
      // hidden by a filter or a dedupe merge in the seconds between rating and
      // delivery, and sending it anyway is the one failure a user notices.
      // `accepted` is selected by the outbox query rather than read off the row,
      // and it is asked in the positive: a missing answer means "not accepted",
      // so a query that forgets it sends nothing rather than sending everything.
      const visible = group.rows.filter((row) => row.state === 'active' && Boolean(row.accepted));
      const hidden = group.rows.filter((row) => !visible.includes(row)).map((row) => row.id);
      if (hidden.length)
        markDeliveriesCancelled(hidden, 'Listing hidden before notification delivery', 'listing_hidden');
      if (!visible.length) continue;

      try {
        const formatted = visible.map((row) => decorateDigestListing(formatListing(row), row, scores.get(row.id)));
        await telegram.send({
          serviceName: group.provider,
          newListings: formatted,
          adapter,
          jobKey: group.jobId,
        });
        markDeliveriesSent(visible.map((row) => row.id));
        // Durable, unlike the work row: terminal work is pruned after thirty
        // days, so an advert still live on day thirty-one used to be announced
        // a second time. A verdict is not transient state.
        //
        // Marked for every job that accepted the advert, not just this group's.
        // One message per advert is deliberate, so the other accepting jobs will
        // never produce a delivery of their own to mark it with.
        for (const row of visible) markVerdictNotified(row.id);
      } catch (error) {
        logger.event(
          'notification_delivery_failure',
          'warn',
          `Notification delivery failed for job '${group.jobId}'.`,
          error,
        );
        markDeliveriesFailed(
          visible.map((row) => row.id),
          error,
        );
      }
    }
  }
}

/**
 * Enrich a formatted listing with the most relevant structured fields, the
 * extraction comments, and the persisted market score. Everything is a
 * first-class field the adapter renders directly, which is what keeps the
 * address block clean.
 *
 * @param {object} formatted formatListing output (copied listing)
 * @param {object} row raw outbox row including joined listing_attributes
 * @param {object|undefined} score reconstructed market score for this listing
 * @returns {object} the enriched listing
 */
function decorateDigestListing(formatted, row, score) {
  // Prefer the durable local image, which Telegram can upload as bytes. The
  // external header URL remains available as the second layer.
  formatted.image = row.image_url || null;
  formatted.imagePath = row.stored_image_path || null;
  formatted.hasImage = Boolean(row.stored_image_path || row.image_url);
  formatted.facts = listingFactsGerman(row);
  formatted.summary = row.summary || null;
  // The catch-all the schema keeps so the structured fields can stay small. It
  // was written on every extraction and read by nothing, which made it a field
  // the model filled for no one.
  formatted.comments = row.comments || null;
  formatted.scoreLine = score ? safeScoreLine(score) : null;
  if (score) formatted.marketScore = score;
  return formatted;
}

function safeScoreLine(score) {
  try {
    return formatScoreLine(score);
  } catch {
    return null;
  }
}

function groupDeliveries(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.job_id}|${row.provider}`;
    if (!groups.has(key)) {
      groups.set(key, { jobId: row.job_id, provider: row.provider, rows: [] });
    }
    groups.get(key).rows.push(row);
  }
  return groups;
}
