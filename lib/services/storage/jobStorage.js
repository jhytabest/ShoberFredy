/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from './SqliteConnection.js';
import { getBlacklist } from './settingsStorage.js';
import { fromJson } from '../../utils.js';

export const getJob = (jobId) => {
  const row = SqliteConnection.query(
    `SELECT j.id,
            j.user_id AS userId,
            j.enabled,
            j.name,
            j.provider,
            j.notification_adapter AS notificationAdapter,
            j.spatial_filter AS spatialFilter,
            j.spec_filter AS specFilter,
            j.last_run_at AS lastRunAt,
            (SELECT COUNT(1) FROM listing_verdicts v JOIN listings l ON l.id = v.listing_id
        WHERE v.job_id = j.id AND v.verdict = 'accepted' AND l.state = 'active') AS numberOfFoundListings
     FROM jobs j
     WHERE j.id = @id
       LIMIT 1`,
    { id: jobId },
  )[0];
  if (!row) return null;
  return {
    ...row,
    enabled: !!row.enabled,
    blacklist: getBlacklist(),
    provider: fromJson(row.provider, []),
    notificationAdapter: fromJson(row.notificationAdapter, []),
    spatialFilter: fromJson(row.spatialFilter, null),
    specFilter: fromJson(row.specFilter, null),
  };
};

export const updateJobLastRunAt = (jobId, timestamp) => {
  SqliteConnection.execute(`UPDATE jobs SET last_run_at = @timestamp WHERE id = @id`, {
    id: jobId,
    timestamp,
  });
};

export const setJobStatus = ({ jobId, status }) => {
  SqliteConnection.execute(`UPDATE jobs SET enabled = @enabled WHERE id = @id`, {
    id: jobId,
    enabled: status ? 1 : 0,
  });
};

export const removeJob = (jobId) => {
  SqliteConnection.withTransaction((db) => {
    db.prepare(`DELETE FROM jobs WHERE id = ?`).run(jobId);
    db.prepare(
      `DELETE FROM listings
       WHERE NOT EXISTS (SELECT 1 FROM listing_verdicts v WHERE v.listing_id = listings.id)
         AND NOT EXISTS (SELECT 1 FROM listing_sources s WHERE s.listing_id = listings.id)`,
    ).run();
  });
};

export const getJobs = ({ includeDisabled = false } = {}) => {
  const rows = SqliteConnection.query(
    `SELECT j.id,
            j.user_id AS userId,
            j.enabled,
            j.name,
            j.provider,
            j.notification_adapter AS notificationAdapter,
            j.spatial_filter AS spatialFilter,
            j.spec_filter AS specFilter,
            j.last_run_at AS lastRunAt,
            (SELECT COUNT(1) FROM listing_verdicts v JOIN listings l ON l.id = v.listing_id
        WHERE v.job_id = j.id AND v.verdict = 'accepted' AND l.state = 'active') AS numberOfFoundListings
     FROM jobs j
     ${includeDisabled ? '' : 'WHERE j.enabled = 1'}
     ORDER BY j.name IS NULL, j.name`,
  );
  return rows.map((row) => ({
    ...row,
    enabled: !!row.enabled,
    blacklist: getBlacklist(),
    provider: fromJson(row.provider, []),
    notificationAdapter: fromJson(row.notificationAdapter, []),
    spatialFilter: fromJson(row.spatialFilter, null),
    specFilter: fromJson(row.specFilter, null),
  }));
};

export const queryJobs = ({
  pageSize = 50,
  page = 1,
  activityFilter,
  freeTextFilter,
  sortField = null,
  sortDir = 'asc',
} = {}) => {
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.min(1000, Math.floor(pageSize)) : 50;
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const offset = (safePage - 1) * safePageSize;

  const whereParts = [];
  const params = { limit: safePageSize, offset };
  if (freeTextFilter && String(freeTextFilter).trim().length > 0) {
    params.filter = `%${String(freeTextFilter).trim()}%`;
    whereParts.push(`(j.name LIKE @filter)`);
  }

  if (activityFilter === true) {
    whereParts.push('(j.enabled = 1)');
  } else if (activityFilter === false) {
    whereParts.push('(j.enabled = 0)');
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const sortable = new Set(['name', 'numberOfFoundListings', 'enabled']);
  const safeSortField = sortField && sortable.has(sortField) ? sortField : null;
  const safeSortDir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  let orderSql = 'ORDER BY j.name IS NULL, j.name ASC';
  if (safeSortField) {
    if (safeSortField === 'numberOfFoundListings') {
      orderSql = `ORDER BY numberOfFoundListings ${safeSortDir}`;
    } else {
      orderSql = `ORDER BY j.${safeSortField} ${safeSortDir}`;
    }
  }

  const countRow = SqliteConnection.query(
    `SELECT COUNT(1) as cnt
     FROM jobs j
       ${whereSql}`,
    params,
  );
  const totalNumber = countRow?.[0]?.cnt ?? 0;

  const rows = SqliteConnection.query(
    `SELECT j.id,
            j.user_id AS userId,
            j.enabled,
            j.name,
            j.provider,
            j.notification_adapter AS notificationAdapter,
            j.spatial_filter AS spatialFilter,
            j.spec_filter AS specFilter,
            j.last_run_at AS lastRunAt,
            (SELECT COUNT(1) FROM listing_verdicts v JOIN listings l ON l.id = v.listing_id
        WHERE v.job_id = j.id AND v.verdict = 'accepted' AND l.state = 'active') AS numberOfFoundListings
     FROM jobs j
       ${whereSql}
       ${orderSql}
       LIMIT @limit OFFSET @offset`,
    params,
  );

  const result = rows.map((row) => ({
    ...row,
    enabled: !!row.enabled,
    blacklist: getBlacklist(),
    provider: fromJson(row.provider, []),
    notificationAdapter: fromJson(row.notificationAdapter, []),
    spatialFilter: fromJson(row.spatialFilter, null),
    specFilter: fromJson(row.specFilter, null),
  }));

  return { totalNumber, page: safePage, result };
};
