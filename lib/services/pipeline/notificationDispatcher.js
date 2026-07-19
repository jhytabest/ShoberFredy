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
  getListingScores,
  getNextDeliveryAt,
  markDeliveriesCancelled,
  markDeliveriesFailed,
  markDeliveriesSent,
} from './notificationOutbox.js';
import { bus } from '../events/event-bus.js';

let running = false;
let started = false;
let timer = null;
let rerun = false;

/**
 * Dispatch durable deliveries when rating creates them. Failed deliveries use
 * one exact wake-up timer for their persisted retry time; there is no polling.
 */
export function startNotificationDispatcher() {
  if (process.env.FREDY_NOTIFICATION_ENABLED === '0') {
    logger.info('Notification dispatcher is disabled.');
    return;
  }
  if (started) return;
  started = true;
  bus.on('notifications:ready', wakeDispatcher);
  bus.on('notifications:reschedule', rescheduleDispatcher);
  wakeDispatcher();
  logger.info('Event-driven notification dispatcher started.');
}

export async function dispatchDueNotifications(now = Date.now()) {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    const rows = getDueDeliveries(now);
    const scores = getListingScores([...new Set(rows.map((row) => row.id))]);
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
      if (!notify.hasAdapter(adapter.id)) {
        markDeliveriesCancelled(ids, `Notification adapter module '${adapter.id}' is not installed`);
        continue;
      }
      const visible = group.rows.filter(
        (row) => row.is_active !== 0 && row.manually_deleted === 0 && !row.hidden_reason,
      );
      const cancelled = group.rows.filter((row) => !visible.includes(row)).map((row) => row.delivery_id);
      if (cancelled.length) markDeliveriesCancelled(cancelled, 'Listing hidden before notification delivery');
      if (!visible.length) continue;

      try {
        const formatted = visible.map((row) => decorateDigestListing(formatListing(row), row, scores.get(row.id)));
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
    if (started) {
      if (rerun) {
        rerun = false;
        scheduleDispatch(0);
      } else {
        scheduleNextRetry();
      }
    }
  }
}

function wakeDispatcher() {
  if (running) {
    rerun = true;
    return;
  }
  scheduleDispatch(0);
}

function rescheduleDispatcher() {
  if (!running) scheduleNextRetry();
}

function scheduleNextRetry() {
  const nextAt = getNextDeliveryAt();
  if (nextAt == null) {
    clearScheduledDispatch();
    return;
  }
  scheduleDispatch(Math.max(0, Number(nextAt) - Date.now()));
}

function scheduleDispatch(delayMs) {
  clearScheduledDispatch();
  // Node timers cannot exceed a signed 32-bit delay. A delivery beyond that
  // boundary gets one safe long timer and will schedule its remainder then.
  timer = setTimeout(
    () => {
      timer = null;
      void dispatchDueNotifications();
    },
    Math.min(delayMs, 2_147_483_647),
  );
}

function clearScheduledDispatch() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * Enrich a formatted listing with the most relevant structured fields, the
 * extraction comments, and the persisted market score. Everything is
 * appended to the address block because every notification adapter renders
 * it; `marketScore` lets notify.js add the model score line.
 *
 * @param {object} formatted formatListing output (copied listing)
 * @param {object} row raw outbox row including joined listing_attributes
 * @param {object|undefined} score reconstructed market score for this listing
 * @returns {object} the enriched listing
 */
function decorateDigestListing(formatted, row, score) {
  const lines = [];
  const details = [
    row.listing_type && row.listing_type !== 'unknown' ? row.listing_type : null,
    row.property_type && row.property_type !== 'unknown' ? row.property_type : null,
    row.cold_rent_eur != null ? `cold ${row.cold_rent_eur} €` : null,
    row.warm_rent_eur != null ? `warm ${row.warm_rent_eur} €` : null,
    row.deposit_eur != null ? `deposit ${row.deposit_eur} €` : null,
    row.floor != null ? `floor ${row.floor}` : null,
    row.building_year != null ? `built ${row.building_year}` : null,
    availabilityLabel(row),
    furnishingLabel(row),
    petsLabel(row),
    amenitiesLabel(row.amenities_json),
  ].filter(Boolean);
  if (details.length) lines.push(details.join(' · '));
  if (row.comments) lines.push(`» ${row.comments}`);
  if (lines.length) formatted.address = `${formatted.address || ''}\n${lines.join('\n')}`;
  if (score) formatted.marketScore = score;
  return formatted;
}

function furnishingLabel(row) {
  if (row.furnishing_status === 'partial') return 'partially furnished';
  if (row.furnishing_status === 'full' || row.furnished === 1) return 'furnished';
  if (row.furnishing_status === 'none') return 'unfurnished';
  return null;
}

function petsLabel(row) {
  if (row.pets_policy === 'conditional') return 'pets by agreement';
  if (row.pets_policy === 'preferred_no') return 'pets discouraged';
  if (row.pets_policy === 'prohibited' || row.pets_allowed === 0) return 'no pets';
  if (row.pets_policy === 'allowed' || row.pets_allowed === 1) return 'pets allowed';
  return null;
}

function availabilityLabel(row) {
  if (row.availability === 'immediate') return 'available now';
  if (row.availability === 'date' && row.available_from) return `available ${row.available_from}`;
  if (row.availability === 'flexible') return 'availability flexible';
  return null;
}

function amenitiesLabel(amenitiesJson) {
  try {
    const amenities = JSON.parse(amenitiesJson || '[]');
    if (!Array.isArray(amenities) || amenities.length === 0) return null;
    return amenities.slice(0, 8).join(', ');
  } catch {
    return null;
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
