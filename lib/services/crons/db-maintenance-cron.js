/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import cron from 'node-cron';
import logger from '../logger.js';
import { runDbMaintenance } from '../maintenance/databaseCleanup.js';

export async function initDbMaintenanceCron() {
  if (process.env.FREDY_DB_MAINTENANCE_ENABLED === '0') {
    logger.info('DB maintenance cron is disabled.');
    return;
  }
  // Daily at 02:30, after the market retrain / active-checker windows.
  cron.schedule('30 2 * * *', () => {
    try {
      runDbMaintenance();
    } catch (error) {
      logger.error('DB maintenance run failed:', error);
    }
  });
  logger.info('DB maintenance cron scheduled (daily 02:30).');
}
