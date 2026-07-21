/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'fs';
import logger from '../services/logger.js';
const path = './adapter';

/** Read every integration existing in ./adapter **/
const adapter = await Promise.all(
  fs
    .readdirSync('./lib/notification/adapter')
    .filter((file) => file.endsWith('.js'))
    .map(async (integPath) => await import(`${path}/${integPath}`)),
);

if (adapter.length === 0) {
  throw new Error('Please specify at least one notification provider');
}
const findAdapter = (notificationAdapter) => {
  return adapter.find((a) => a.config.id === notificationAdapter.id);
};

/**
 * Whether a notification adapter module with this id is installed. The
 * dispatcher checks this before marking deliveries as sent, so a removed
 * adapter module can never silently swallow notifications.
 *
 * @param {string} adapterId
 * @returns {boolean}
 */
export const hasAdapter = (adapterId) => adapter.some((a) => a.config.id === adapterId);

export const send = (serviceName, newListings, notificationConfig, jobKey, baseUrl) => {
  // Listings arrive already enriched by the dispatcher with first-class
  // `facts`, `summary`, `scoreLine` and `image` fields; adapters render those
  // directly (the address field is left clean).
  return notificationConfig
    .map((notificationAdapter) => {
      const found = findAdapter(notificationAdapter);
      if (!found) {
        logger.warn(`Notification adapter '${notificationAdapter.id}' not found for job '${jobKey || ''}'`);
      }
      return found;
    })
    .filter(Boolean)
    .map((a) => a.send({ serviceName, newListings, notificationConfig, jobKey, baseUrl }));
};
