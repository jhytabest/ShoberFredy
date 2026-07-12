/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fs from 'fs';
import logger from '../services/logger.js';
import { formatScoreLine } from '../services/scoring/marketScore.js';
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
 * Append the market-score metrics line (computed at save time) to the
 * address field, which every adapter renders. Notification-only: the
 * listings are already persisted without the line.
 *
 * @param {object[]} listings formatted listings, possibly carrying marketScore
 * @returns {object[]} the same listings, decorated in place
 */
const decorateWithMarketScore = (listings) => {
  for (const listing of listings) {
    try {
      if (listing.marketScore) {
        listing.address = `${listing.address || ''}\n${formatScoreLine(listing.marketScore)}`;
      }
    } catch (error) {
      logger.warn(`market score rendering failed for '${listing.title}'; notifying undecorated`, error);
    }
  }
  return listings;
};

export const send = (serviceName, newListings, notificationConfig, jobKey, baseUrl) => {
  const decorated = decorateWithMarketScore(newListings);
  //this is not being used in tests, therefore adapter are always set
  return notificationConfig
    .map((notificationAdapter) => {
      const found = findAdapter(notificationAdapter);
      if (!found) {
        logger.warn(`Notification adapter '${notificationAdapter.id}' not found for job '${jobKey || ''}'`);
      }
      return found;
    })
    .filter(Boolean)
    .map((a) => a.send({ serviceName, newListings: decorated, notificationConfig, jobKey, baseUrl }));
};
