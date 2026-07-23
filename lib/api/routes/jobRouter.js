/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as jobStorage from '../../services/storage/jobStorage.js';
import logger from '../../services/logger.js';
import { bus } from '../../services/events/event-bus.js';
import { isRunning as isJobRunning } from '../../services/jobs/run-state.js';
import { addClient as addSseClient, removeClient } from '../../services/sse/sse-broker.js';

function ownsJob(job, request) {
  return Boolean(job && request.session.currentUser && job.userId === request.session.currentUser);
}

function normalizeTelegram(adapters) {
  const telegram = Array.isArray(adapters) ? adapters.find((adapter) => adapter?.id === 'telegram') : null;
  if (!telegram?.fields?.token?.trim() || !telegram?.fields?.chatId?.trim()) {
    throw new Error('Telegram token and chat ID are required.');
  }
  return [{ id: 'telegram', name: 'Telegram', fields: telegram.fields }];
}

export default async function jobPlugin(fastify) {
  fastify.get('/', async () =>
    jobStorage.getJobs({ includeDisabled: true }).map((job) => ({ ...job, running: isJobRunning(job.id) })),
  );

  fastify.get('/data', async (request) => {
    const {
      page,
      pageSize = 50,
      activityFilter,
      sortfield = null,
      sortdir = 'asc',
      freeTextFilter,
    } = request.query || {};
    const toBool = (value) => {
      if (value === true || value === 'true' || value === 1 || value === '1') return true;
      if (value === false || value === 'false' || value === 0 || value === '0') return false;
      return null;
    };
    const result = jobStorage.queryJobs({
      page: page ? parseInt(page, 10) : 1,
      pageSize: pageSize ? parseInt(pageSize, 10) : 50,
      freeTextFilter: freeTextFilter || null,
      activityFilter: toBool(activityFilter),
      sortField: sortfield || null,
      sortDir: sortdir === 'desc' ? 'desc' : 'asc',
    });
    result.result = result.result.map((job) => ({ ...job, running: isJobRunning(job.id) }));
    return result;
  });

  fastify.get('/events', async (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache');
    raw.setHeader('Connection', 'keep-alive');
    try {
      raw.write(': connected\n\n');
      addSseClient(request.session.currentUser, raw);
      request.raw.on('close', () => removeClient(request.session.currentUser, raw));
    } catch (error) {
      logger.error('Error establishing SSE connection', error);
      raw.end();
    }
  });

  fastify.post('/startAll', async (_request, reply) => {
    bus.emit('jobs:runAll');
    return reply.code(202).send({ message: 'Run all accepted' });
  });

  fastify.post('/:jobId/run', async (request, reply) => {
    const job = jobStorage.getJob(request.params.jobId);
    if (!job) return reply.code(404).send({ message: 'Job not found' });
    if (!ownsJob(job, request)) return reply.code(403).send({ message: 'Job does not belong to this account' });
    if (isJobRunning(job.id)) return reply.code(409).send({ message: 'Job is already running' });
    bus.emit('jobs:runOne', { jobId: job.id });
    return reply.code(202).send({ message: 'Job run accepted' });
  });

  fastify.post('/', async (request, reply) => {
    const {
      provider,
      notificationAdapter,
      name,
      blacklist = [],
      jobId,
      enabled,
      spatialFilter = null,
      specFilter = null,
    } = request.body || {};
    try {
      const existing = jobId ? jobStorage.getJob(jobId) : null;
      if (existing && !ownsJob(existing, request)) {
        return reply.code(403).send({ error: 'Job does not belong to this account.' });
      }
      jobStorage.upsertJob({
        userId: request.session.currentUser,
        jobId,
        enabled,
        name,
        blacklist,
        provider,
        notificationAdapter: normalizeTelegram(notificationAdapter),
        spatialFilter,
        specFilter,
      });
      return reply.send();
    } catch (error) {
      logger.error(error);
      return reply.code(400).send({ error: error.message, message: error.message });
    }
  });

  fastify.delete('/', async (request, reply) => {
    const job = jobStorage.getJob(request.body?.jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (!ownsJob(job, request)) return reply.code(403).send({ error: 'Job does not belong to this account' });
    jobStorage.removeJob(job.id);
    return reply.send();
  });

  fastify.put('/:jobId/status', async (request, reply) => {
    const job = jobStorage.getJob(request.params.jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (!ownsJob(job, request)) return reply.code(403).send({ error: 'Job does not belong to this account' });
    jobStorage.setJobStatus({ jobId: job.id, status: request.body?.status });
    return reply.send();
  });
}
