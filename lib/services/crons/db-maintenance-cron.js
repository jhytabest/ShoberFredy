/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import cron from 'node-cron';
import logger from '../logger.js';
import { runDbMaintenance } from '../maintenance/databaseCleanup.js';
import { applyCanonicalDedupe } from '../maintenance/canonicalDedupe.js';

export async function initDbMaintenanceCron() {
  if (process.env.FREDY_DB_MAINTENANCE_ENABLED === '0') {
    logger.info('DB maintenance cron is disabled.');
    return;
  }
  // Daily at 02:30, after the market retrain / active-checker windows.
  cron.schedule('30 2 * * *', () => {
    // Dedupe belongs to the pipeline, not to an operator's errand list. The
    // live layers catch a duplicate as each listing is parsed, but they can
    // only compare against what is already stored: two portals publishing the
    // same flat inside one run, or a pair that only becomes comparable once a
    // later geocode lands, are both left for this sweep. It absorbs duplicates
    // by hiding them, so a rediscovered ad is still recognised and neither
    // fetched nor notified again.
    try {
      const summary = applyCanonicalDedupe();
      if (summary.duplicatesToMerge > 0) {
        logger.info(
          `Canonical dedupe: absorbed ${summary.duplicatesToMerge} duplicate(s) across ` +
            `${summary.clusters} cluster(s).`,
        );
      }
    } catch (error) {
      logger.error('Canonical dedupe run failed:', error);
    }

    try {
      runDbMaintenance();
    } catch (error) {
      logger.error('DB maintenance run failed:', error);
    }
  });
  logger.info('DB maintenance cron scheduled (daily 02:30: canonical dedupe, then upkeep).');
}
