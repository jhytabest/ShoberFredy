/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getUserSettings, upsertSettings } from '../../services/storage/settingsStorage.js';
import { resetDistancesForUser } from '../../services/storage/listingsStorage.js';
import { geocodeAddress } from '../../services/geocoding/geoCodingService.js';
import { autocompleteAddress } from '../../services/geocoding/autocompleteService.js';
import { calculateDistanceForUser } from '../../services/geocoding/distanceService.js';
import logger from '../../services/logger.js';

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function userSettingsPlugin(fastify) {
  fastify.get('/', async (request) => {
    const userId = request.session.currentUser;
    return getUserSettings(userId);
  });

  fastify.get('/autocomplete', async (request, reply) => {
    const { q } = request.query;
    try {
      const results = await autocompleteAddress(q);
      return results;
    } catch (error) {
      return reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/home-address', async (request, reply) => {
    const userId = request.session.currentUser;
    const { home_address } = request.body;
    try {
      if (home_address) {
        const coords = await geocodeAddress(home_address);
        if (coords && coords.lat !== -1) {
          upsertSettings({ home_address: { address: home_address, coords } }, userId);
          resetDistancesForUser(userId);
          // Recompute distances against the new home address right away
          // (listing coordinates are untouched — they live in the geocode cache).
          calculateDistanceForUser(userId);
          return { success: true, coords };
        } else {
          return reply.code(400).send({ error: 'Could not geocode address' });
        }
      } else {
        upsertSettings({ home_address: null }, userId);
        return { success: true };
      }
    } catch (error) {
      logger.error('Error updating home address settings', error);
      return reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/listings-view-mode', async (request, reply) => {
    const userId = request.session.currentUser;
    const { listings_view_mode } = request.body;

    if (listings_view_mode !== 'grid' && listings_view_mode !== 'table') {
      return reply.code(400).send({ error: 'listings_view_mode must be "grid" or "table".' });
    }

    try {
      upsertSettings({ listings_view_mode }, userId);
      return { success: true };
    } catch (error) {
      logger.error('Error updating listings view mode setting', error);
      return reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/jobs-view-mode', async (request, reply) => {
    const userId = request.session.currentUser;
    const { jobs_view_mode } = request.body;

    if (jobs_view_mode !== 'grid' && jobs_view_mode !== 'table') {
      return reply.code(400).send({ error: 'jobs_view_mode must be "grid" or "table".' });
    }

    try {
      upsertSettings({ jobs_view_mode }, userId);
      return { success: true };
    } catch (error) {
      logger.error('Error updating jobs view mode setting', error);
      return reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/listing-deletion-preference', async (request, reply) => {
    const userId = request.session.currentUser;
    const { listing_deletion_preference } = request.body;

    if (listing_deletion_preference == null) {
      return reply.code(400).send({ error: 'listing_deletion_preference is required.' });
    }

    const { skipPrompt, hardDelete } = listing_deletion_preference;

    try {
      upsertSettings({ listing_deletion_preference: { skipPrompt, hardDelete } }, userId);
      return { success: true };
    } catch (error) {
      logger.error('Error updating listing deletion preference', error);
      return reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/language', async (request, reply) => {
    const userId = request.session.currentUser;
    const { language } = request.body;

    if (typeof language !== 'string' || language.trim() === '') {
      return reply.code(400).send({ error: 'language must be a non-empty string.' });
    }

    try {
      upsertSettings({ language }, userId);
      return { success: true };
    } catch (error) {
      logger.error('Error updating language setting', error);
      return reply.code(500).send({ error: error.message });
    }
  });
}
