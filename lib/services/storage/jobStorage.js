/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { nanoid } from 'nanoid';
import SqliteConnection from './SqliteConnection.js';
import { fromJson, toJson } from '../../utils.js';
import { normalizeMarket } from '../../shared/markets.js';

const JOB_COLUMNS = `j.id, j.enabled, j.name, j.city, j.interval,
  j.working_hours AS workingHours, j.provider, j.last_run_at AS lastRunAt`;

// One reader for discovery configuration.
function toJob(row) {
  return {
    ...row,
    enabled: !!row.enabled,
    market: normalizeMarket(row.city),
    workingHours: fromJson(row.workingHours, { from: '', to: '' }),
    provider: fromJson(row.provider, []),
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

// Cadence is checked per (job, provider), not per job — two providers on the
// same job can be due at different times. Read in bulk once per scheduler
// tick rather than once per pair, so the tick cost does not grow with jobs x
// providers.
export const getProviderSchedule = () => {
  const rows = SqliteConnection.query(`SELECT job_id AS jobId, provider, last_run_at AS lastRunAt
                                        FROM job_provider_schedule`);
  const byPair = new Map();
  for (const row of rows) byPair.set(`${row.jobId}:${row.provider}`, row.lastRunAt);
  return byPair;
};

export const markProviderRunAt = (jobId, provider, timestamp) => {
  SqliteConnection.execute(
    `INSERT INTO job_provider_schedule (job_id, provider, last_run_at)
     VALUES (@jobId, @provider, @timestamp)
     ON CONFLICT(job_id, provider) DO UPDATE SET last_run_at = excluded.last_run_at`,
    { jobId, provider, timestamp },
  );
};

export const setJobStatus = ({ jobId, status }) => {
  SqliteConnection.execute(`UPDATE jobs SET enabled = @enabled WHERE id = @id`, {
    id: jobId,
    enabled: status ? 1 : 0,
  });
};

export const removeJob = (jobId) => {
  SqliteConnection.execute('DELETE FROM jobs WHERE id = @id', { id: jobId });
};

// The write path receives validated discovery documents.
export const createJob = (document) => {
  const id = document.id || nanoid();
  SqliteConnection.execute(
    `INSERT INTO jobs (id, enabled, name, city, interval, working_hours, provider)
     VALUES (@id, @enabled, @name, @city, @interval, @workingHours, @provider)`,
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
  provider: [],
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
  provider: 'provider',
};

function storedColumns(document) {
  const stored = {};
  if ('id' in document) stored.id = document.id;
  if ('enabled' in document) stored.enabled = document.enabled ? 1 : 0;
  if ('name' in document) stored.name = document.name ?? null;
  if ('city' in document) stored.city = document.city ?? null;
  if ('interval' in document) stored.interval = document.interval ?? null;
  if ('workingHours' in document) stored.workingHours = toJson(document.workingHours ?? { from: '', to: '' });
  if ('provider' in document) stored.provider = toJson(document.provider ?? []);
  return stored;
}
