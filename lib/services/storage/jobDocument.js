/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getProviders } from '../../utils.js';

// Jobs describe discovery inputs. Shared pipeline policy is configured separately.

export class JobDocumentError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'JobDocumentError';
    this.problems = problems;
  }
}

const FIELDS = new Set([
  'enabled',
  'name',
  'city',
  'interval',
  'workingHours',
  'provider',
]);

const REQUIRED_FOR_NEW = ['name', 'city', 'provider', 'interval'];

export async function validateJobDocument(document, { partial = false } = {}) {
  const problems = [];
  if (document == null || typeof document !== 'object' || Array.isArray(document)) {
    throw new JobDocumentError(['A job must be a JSON object']);
  }

  for (const key of Object.keys(document)) {
    if (!FIELDS.has(key)) problems.push(`Unknown job field '${key}'`);
  }
  if (!partial) {
    for (const key of REQUIRED_FOR_NEW) {
      if (!(key in document)) problems.push(`A new job needs '${key}'`);
    }
  }

  if ('name' in document && !nonEmptyString(document.name)) problems.push(`'name' must be a non-empty string`);
  if ('city' in document && !nonEmptyString(document.city)) problems.push(`'city' must be a non-empty string`);
  if ('enabled' in document && typeof document.enabled !== 'boolean') problems.push(`'enabled' must be true or false`);

  if ('interval' in document) problems.push(...intervalProblems(document.interval));
  if ('workingHours' in document) problems.push(...workingHoursProblems(document.workingHours));
  if ('provider' in document) problems.push(...(await providerProblems(document.provider)));

  if (problems.length) throw new JobDocumentError(problems);
  return document;
}

async function providerProblems(provider) {
  if (!Array.isArray(provider) || provider.length === 0) {
    return [`'provider' must be a non-empty array of { id, url } entries`];
  }
  const loaded = await getProviders();
  const known = loaded.map((module) => module.metaInformation.id);
  const problems = [];
  for (const [index, entry] of provider.entries()) {
    const at = `provider[${index}]`;
    if (entry == null || typeof entry !== 'object') {
      problems.push(`${at} must be an object`);
      continue;
    }
    if (!known.includes(entry.id)) {
      problems.push(`${at}.id '${entry.id}' is not a provider. Known: ${known.join(', ')}`);
    }
    if (!httpUrl(entry.url)) problems.push(`${at}.url must be an http(s) URL`);
    if ('maxPages' in entry && entry.maxPages != null) {
      if (!(Number.isInteger(entry.maxPages) && entry.maxPages > 0)) {
        problems.push(`${at}.maxPages must be a positive integer`);
      }
    }
  }
  return problems;
}

function intervalProblems(interval) {
  return Number.isInteger(interval) && interval > 0 ? [] : [`'interval' must be a positive integer (minutes)`];
}

function workingHoursProblems(workingHours) {
  if (workingHours == null) return [];
  if (typeof workingHours !== 'object' || Array.isArray(workingHours)) {
    return [`'workingHours' must be an object with 'from' and 'to'`];
  }
  const problems = [];
  for (const key of ['from', 'to']) {
    if (key in workingHours && workingHours[key] != null && typeof workingHours[key] !== 'string') {
      problems.push(`workingHours.${key} must be a string (e.g. '08:00') or empty`);
    }
  }
  return problems;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function httpUrl(value) {
  if (!nonEmptyString(value)) return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function berlinRentalJob(document) {
  return { ...document, city: 'Berlin', interval: document.interval ?? 15,
    workingHours: document.workingHours ?? { from: '', to: '' } };
}
