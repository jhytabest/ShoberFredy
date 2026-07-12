/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { autocomplete as googleAutocomplete } from './client/googleClient.js';
import logger from '../logger.js';

/**
 * Autocompletes an address using Google Geocoding.
 *
 * @param {string} query - The search query.
 * @returns {Promise<string[]>} List of matching addresses.
 */
export async function autocompleteAddress(query) {
  if (!query) {
    return [];
  }

  try {
    return await googleAutocomplete(query);
  } catch (error) {
    logger.error('Error during address autocomplete:', error);
    return [];
  }
}
