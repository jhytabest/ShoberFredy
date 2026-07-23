/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../services/logger.js';
import * as telegram from './adapter/telegram.js';

/**
 * Whether a notification adapter module with this id is installed. The
 * dispatcher checks this before marking deliveries as sent, so a removed
 * adapter module can never silently swallow notifications.
 *
 * @param {string} adapterId
 * @returns {boolean}
 */
export const hasAdapter = (adapterId) => adapterId === telegram.config.id;

export const send = (serviceName, newListings, notificationConfig, jobKey, baseUrl) => {
  // Listings arrive already enriched by the dispatcher with first-class
  // `facts`, `summary`, `scoreLine` and `image` fields; adapters render those
  // directly (the address field is left clean).
  const configured = notificationConfig?.find((entry) => entry?.id === telegram.config.id);
  if (!configured) {
    logger.warn(`Telegram configuration not found for job '${jobKey || ''}'`);
    return [];
  }
  return [telegram.send({ serviceName, newListings, notificationConfig: [configured], jobKey, baseUrl })];
};
