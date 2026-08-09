/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { nanoid } from 'nanoid';
import SqliteConnection from './SqliteConnection.js';
import { fromJson, toJson } from '../../utils.js';
import { normalizeMarket } from '../market/markets.js';

const JOB_COLUMNS = `j.id,
            j.enabled,
            j.name,
            j.city,
            j.interval,
            j.working_hours AS workingHours,
            j.blacklist,
            j.intent_filter AS intentFilter,
            j.provider,
            j.notify,
            j.spatial_filter AS spatialFilter,
            j.spec_filter AS specFilter,
            j.last_run_at AS lastRunAt,
            (SELECT COUNT(1) FROM listing_verdicts v JOIN listings l ON l.id = v.listing_id
        WHERE v.job_id = j.id AND v.verdict = 'accepted' AND l.state = 'active') AS numberOfFoundListings`;

// One reader for the stored shape, because a job read three different ways was
// a job that could be filtered three different ways.
function toJob(row) {
  return {
    ...row,
    enabled: !!row.enabled,
    market: normalizeMarket(row.city),
    workingHours: fromJson(row.workingHours, { from: '', to: '' }),
    blacklist: fromJson(row.blacklist, []),
    intentFilter: fromJson(row.intentFilter, []),
    provider: fromJson(row.provider, []),
    notify: fromJson(row.notify, null),
    spatialFilter: fromJson(row.spatialFilter, null),
    specFilter: fromJson(row.specFilter, null),
  };
}

export const getJob = (jobId) => {
  const row = SqliteConnection.query(`SELECT ${JOB_COLUMNS} FROM jobs j WHERE j.id = @id LIMIT 1`, { id: jobId })[0];
  return row ? toJob(row) : null;
};

export const getJobs = ({ includeDisabled = false } = {}) => {
  const rows = SqliteConnection.query(
    `SELECT ${JOB_COLUMNS}
     FROM jobs j
     ${includeDisabled ? '' : 'WHERE j.enabled = 1'}
     ORDER BY j.name IS NULL, j.name`,
  );
  return rows.map(toJob);
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

// The write path. Documents arriving here are already validated; storing an
// unvalidated one is how a job ends up with a filter nothing reads.
export const createJob = (document) => {
  const id = document.id || nanoid();
  SqliteConnection.execute(
    `INSERT INTO jobs (id, enabled, name, city, interval, working_hours, blacklist, intent_filter, provider,
                       notify, spatial_filter, spec_filter)
     VALUES (@id, @enabled, @name, @city, @interval, @workingHours, @blacklist, @intentFilter, @provider,
             @notify, @spatialFilter, @specFilter)`,
    storedColumns({ ...EMPTY_JOB, ...document, id }),
  );
  return getJob(id);
};

const EMPTY_JOB = {
  enabled: true,
  name: null,
  city: null,
  interval: null,
  workingHours: { from: '', to: '' },
  blacklist: [],
  intentFilter: [],
  provider: [],
  notify: null,
  spatialFilter: null,
  specFilter: null,
};

export const updateJob = (jobId, patch) => {
  const stored = storedColumns(patch);
  const assignments = Object.keys(stored)
    .filter((key) => key !== 'id')
    .map((key) => `${COLUMN_OF[key]} = @${key}`);
  if (!assignments.length) return getJob(jobId);
  SqliteConnection.execute(`UPDATE jobs SET ${assignments.join(', ')} WHERE id = @id`, { ...stored, id: jobId });
  return getJob(jobId);
};

const COLUMN_OF = {
  enabled: 'enabled',
  name: 'name',
  city: 'city',
  interval: 'interval',
  workingHours: 'working_hours',
  blacklist: 'blacklist',
  intentFilter: 'intent_filter',
  provider: 'provider',
  notify: 'notify',
  spatialFilter: 'spatial_filter',
  specFilter: 'spec_filter',
};

function storedColumns(document) {
  const stored = {};
  if ('id' in document) stored.id = document.id;
  if ('enabled' in document) stored.enabled = document.enabled ? 1 : 0;
  if ('name' in document) stored.name = document.name ?? null;
  if ('city' in document) stored.city = document.city ?? null;
  if ('interval' in document) stored.interval = document.interval ?? null;
  if ('workingHours' in document) stored.workingHours = toJson(document.workingHours ?? { from: '', to: '' });
  if ('blacklist' in document) stored.blacklist = toJson(document.blacklist ?? []);
  if ('intentFilter' in document) stored.intentFilter = toJson(document.intentFilter ?? []);
  if ('provider' in document) stored.provider = toJson(document.provider ?? []);
  if ('notify' in document) stored.notify = document.notify ? toJson(document.notify) : null;
  if ('spatialFilter' in document)
    stored.spatialFilter = document.spatialFilter ? toJson(document.spatialFilter) : null;
  if ('specFilter' in document) stored.specFilter = document.specFilter ? toJson(document.specFilter) : null;
  return stored;
}
