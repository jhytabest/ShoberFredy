/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import SqliteConnection from '../storage/SqliteConnection.js';
import { decideListing } from '../jobs/jobDecisionService.js';
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
    handler: (item, { signal }) => dispatchDeliveries(item.items ?? [item], signal),
  });
  return startWorker('notify');
}

async function dispatchDeliveries(items, signal) {
  {
    const rows = deliveriesForKeys(items.map((item) => item.key));
    for (const group of groupDeliveries(rows).values()) {
      const listingIds = group.rows.map((row) => row.delivery_key);
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
      const visible = group.rows.filter(
        (row) => row.state === 'active' && decideListing(SqliteConnection.getConnection(), row, job).accepted,
      );
      const hidden = group.rows.filter((row) => !visible.includes(row)).map((row) => row.delivery_key);
      if (hidden.length)
        markDeliveriesCancelled(hidden, 'Listing hidden before notification delivery', 'listing_hidden');
      if (!visible.length) continue;

      await Promise.all(
        visible.map(async (row) => {
          try {
            signal?.throwIfAborted();
            await telegram.send({
              serviceName: group.provider,
              newListings: [decorateDigestListing(formatListing(row), row)],
              adapter,
              jobKey: group.jobId,
              signal,
            });
            markDeliveriesSent([row.delivery_key]);
            markVerdictNotified(row.id, group.jobId);
          } catch (error) {
            // A batch that ran out of time is failed by the worker, member by
            // member. Recording the abort here as well would spend two attempts
            // on one timeout and retire the delivery early.
            if (signal?.aborted) throw error;
            logger.event(
              'notification_delivery_failure',
              'warn',
              `Notification delivery failed for job '${group.jobId}'.`,
              error,
            );
            markDeliveriesFailed([row.delivery_key], error);
          }
        }),
      );
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
