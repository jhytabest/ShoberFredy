/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import {
  createJob,
  getJob,
  getJobs,
  removeJob,
  setJobStatus,
  updateJob,
} from '../../lib/services/storage/jobStorage.js';
import { validateJobDocument, berlinRentalJob } from '../../lib/services/storage/jobDocument.js';

export const JOBS_USAGE = `  yarn maintenance jobs list
  yarn maintenance jobs show <id>
  yarn maintenance jobs add <json-document>
  yarn maintenance jobs template berlin <json-document>
  yarn maintenance jobs set <id> <field> <json-value>
  yarn maintenance jobs patch <id> <json-document>
  yarn maintenance jobs enable <id>
  yarn maintenance jobs disable <id>
  yarn maintenance jobs remove <id>

A job document is JSON. Every field it needs to run lives on it — there is no
deployment-wide default left to inherit:
  { "name": "München", "city": "München", "interval": 15,
    "workingHours": { "from": "", "to": "" },
    "provider": [{ "id": "wgGesucht", "url": "https://...", "maxPages": 3 }],
    "notify": { "token": "...", "chatId": "-100..." },
    "blacklist": ["Tausch"], "intentFilter": ["swap"],
    "specFilter": { "maxPrice": 900 }, "spatialFilter": null }`;

export async function runJobs(args, { usageError }) {
  const [action, ...rest] = args;

  if (action === 'template' && rest[0] === 'berlin' && rest.length === 2) {
    const document = berlinRentalJob(parseJson(rest[1], 'job document', usageError));
    if (!document.spatialFilter) return usageError('The Berlin job needs its own spatialFilter polygons');
    await validateJobDocument(document);
    return redactNotify(document);
  }

  if (action === 'list' && !rest.length) {
    return getJobs({ includeDisabled: true }).map(summarize);
  }

  if (action === 'show' && rest.length === 1) {
    return redactNotify(required(getJob(rest[0]), rest[0], usageError));
  }

  if (action === 'add' && rest.length === 1) {
    const document = parseJson(rest[0], 'job document', usageError);
    await validateJobDocument(document);
    return createJob(document);
  }

  if (action === 'set' && rest.length === 3) {
    const [id, field, rawValue] = rest;
    required(getJob(id), id, usageError);
    const patch = { [field]: parseJson(rawValue, field, usageError) };
    await validateJobDocument(patch, { partial: true });
    return updateJob(id, patch);
  }

  if (action === 'patch' && rest.length === 2) {
    const [id, rawDocument] = rest;
    required(getJob(id), id, usageError);
    const patch = parseJson(rawDocument, 'job document', usageError);
    await validateJobDocument(patch, { partial: true });
    return updateJob(id, patch);
  }

  if ((action === 'enable' || action === 'disable') && rest.length === 1) {
    const [id] = rest;
    required(getJob(id), id, usageError);
    setJobStatus({ jobId: id, status: action === 'enable' });
    return getJob(id);
  }

  if (action === 'remove' && rest.length === 1) {
    const [id] = rest;
    const job = required(getJob(id), id, usageError);
    removeJob(id);
    return { removed: summarize(job) };
  }

  return usageError(`Unknown jobs command '${[action, ...rest].filter(Boolean).join(' ')}'`);
}

function summarize(job) {
  return {
    id: job.id,
    name: job.name,
    city: job.city,
    market: job.market,
    enabled: job.enabled,
    interval: job.interval,
    workingHours: job.workingHours,
    providers: job.provider.map((entry) => entry.id),
    notify: job.notify ? { ...job.notify, token: '(redacted)' } : null,
    blacklistTerms: job.blacklist.length,
    intentFilter: job.intentFilter,
    specFilter: job.specFilter,
    hasSpatialFilter: Boolean(job.spatialFilter),
    activeAccepted: job.numberOfFoundListings,
    lastRunAt: job.lastRunAt,
  };
}

function redactNotify(job) {
  if (!job?.notify?.token) return job;
  return { ...job, notify: { ...job.notify, token: '(redacted)' } };
}

function required(job, id, usageError) {
  if (!job) usageError(`No job with id '${id}'`);
  return job;
}

function parseJson(raw, what, usageError) {
  try {
    return JSON.parse(raw);
  } catch {
    return usageError(`${what} must be JSON: ${raw}`);
  }
}
