/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import * as notify from '../../notification/notify.js';
import { formatListing } from '../../utils/formatListing.js';
import { getJob } from '../storage/jobStorage.js';
import { getSettings } from '../storage/settingsStorage.js';
import {
  getDueDeliveries,
  markDeliveriesCancelled,
  markDeliveriesFailed,
  markDeliveriesSent,
} from './notificationOutbox.js';

let running = false;

export function startNotificationDispatcher() {
  if (process.env.FREDY_NOTIFICATION_ENABLED === '0') {
    logger.info('Notification dispatcher is disabled.');
    return;
  }
  const intervalMs = positiveEnv('FREDY_NOTIFICATION_INTERVAL_MS', 15 * 60 * 1000);
  setInterval(() => void dispatchDueNotifications(), intervalMs);
  logger.info(`Notification dispatcher scheduled every ${intervalMs} ms.`);
}

export async function dispatchDueNotifications(now = Date.now()) {
  if (running) return;
  running = true;
  try {
    const rows = getDueDeliveries(now);
    const groups = groupDeliveries(rows);
    const settings = await getSettings();
    for (const group of groups.values()) {
      const ids = group.rows.map((row) => row.delivery_id);
      const job = getJob(group.jobId);
      if (!job?.enabled) {
        markDeliveriesCancelled(ids, 'Job disabled before notification delivery');
        continue;
      }
      const adapter = job.notificationAdapter?.[group.adapterOrdinal];
      if (!adapter || adapter.id !== group.adapterId) {
        markDeliveriesCancelled(ids, 'Notification adapter removed before delivery');
        continue;
      }
      const visible = group.rows.filter((row) => row.manually_deleted === 0 && !row.hidden_reason);
      const cancelled = group.rows.filter((row) => !visible.includes(row)).map((row) => row.delivery_id);
      if (cancelled.length) markDeliveriesCancelled(cancelled, 'Listing hidden before notification delivery');
      if (!visible.length) continue;

      try {
        const formatted = visible.map((row) => formatListing(row));
        await Promise.all(notify.send(group.provider, formatted, [adapter], group.jobId, settings?.baseUrl ?? ''));
        markDeliveriesSent(visible.map((row) => row.delivery_id));
      } catch (error) {
        logger.warn(`Notification delivery failed for job '${group.jobId}' adapter '${group.adapterId}'.`, error);
        markDeliveriesFailed(
          visible.map((row) => row.delivery_id),
          error,
        );
      }
    }
  } finally {
    running = false;
  }
}

function groupDeliveries(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.job_id}|${row.provider}|${row.adapter_id}|${row.adapter_ordinal}`;
    if (!groups.has(key)) {
      groups.set(key, {
        jobId: row.job_id,
        provider: row.provider,
        adapterId: row.adapter_id,
        adapterOrdinal: row.adapter_ordinal,
        rows: [],
      });
    }
    groups.get(key).rows.push(row);
  }
  return groups;
}

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
