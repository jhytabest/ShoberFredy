/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import * as telegram from '../../notification/adapter/telegram.js';
import { formatListing } from '../../utils/formatListing.js';
import { listingFactsGerman } from '../../notification/listingLabels.js';
import { getJob } from '../storage/jobStorage.js';
import { markVerdictNotified } from './terminalVerdict.js';
import { env } from '../../shared/env.js';
import { registerHandler, startWorker } from './workQueue.js';
import {
  deliveriesForKeys,
  markDeliveriesCancelled,
  markDeliveriesFailed,
  markDeliveriesSent,
} from './notificationOutbox.js';

const WORKER_NAME = 'notify';

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
    for (const group of groupDeliveries(rows).values()) {
      const listingIds = group.rows.map((row) => row.id);
      const job = getJob(group.jobId);
      if (!job?.enabled) {
        markDeliveriesCancelled(listingIds, 'Job disabled before notification delivery', 'job_disabled');
        continue;
      }
      const notify = job.notify;
      if (!notify?.token || !notify?.chatId) {
        markDeliveriesCancelled(
          listingIds,
          'Telegram configuration removed from the job before delivery',
          'adapter_removed',
        );
        continue;
      }
      const adapter = {
        fields: {
          token: notify.token,
          chatId: notify.chatId,
          messageThreadId: notify.threadId,
          plainText: notify.plainText,
        },
      };
      const visible = group.rows.filter((row) => row.state === 'active' && Boolean(row.accepted));
      const hidden = group.rows.filter((row) => !visible.includes(row)).map((row) => row.id);
      if (hidden.length)
        markDeliveriesCancelled(hidden, 'Listing hidden before notification delivery', 'listing_hidden');
      if (!visible.length) continue;

      try {
        const formatted = visible.map((row) => decorateDigestListing(formatListing(row), row));
        await telegram.send({
          serviceName: group.provider,
          newListings: formatted,
          adapter,
          jobKey: group.jobId,
        });
        markDeliveriesSent(visible.map((row) => row.id));
        for (const row of visible) markVerdictNotified(row.id);
      } catch (error) {
        // Stays at warn deliberately. This fires on every failed attempt, not
        // only on the last one, so a single timed-out send — which the route to
        // Telegram produces on its own often enough to matter — would raise a
        // critical event and notify about it. Sustained failure is the thing
        // worth acting on, and the notification_delivery check now measures
        // exactly that: what share of the work that left the notify queue left
        // it dead rather than delivered.
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

function decorateDigestListing(formatted, row) {
  formatted.image = row.image_url || null;
  formatted.imagePath = row.stored_image_path || null;
  formatted.hasImage = Boolean(row.stored_image_path || row.image_url);
  formatted.facts = listingFactsGerman(row);
  formatted.summary = row.summary || null;
  formatted.comments = row.comments || null;
  return formatted;
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
