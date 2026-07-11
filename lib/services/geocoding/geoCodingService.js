/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Shoberfredy geocoding service.
 *
 * When GOOGLE_GEOCODING_API_KEY is set, addresses are geocoded via Google
 * with a persistent cache (homeserver_geocode_cache) shared with the backfill
 * CLI (tools/market/geocoderBackfill.js), the cross-portal dedupe, the market
 * scorer, the market model, and the metrics exporter. Without a key, the
 * upstream Nominatim flow is used unchanged.
 *
 * Return contract (relied on by the spatial filter in
 * FredyPipelineExecutioner):
 *   {lat, lng}   — geocoded successfully
 *   {-1, -1}     — the geocoder answered and the address is definitively not found
 *   null         — the geocoder could not be asked (quota, denied key,
 *                  transport); the pipeline fails open and keeps the listing
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { getGeocoordinatesByAddress } from '../storage/listingsStorage.js';
import { geocode as nominatimGeocode, isPaused as isNominatimPaused } from './client/nominatimClient.js';
import {
  geocodeAddress as googleGeocodeAddress,
  isGoogleGeocodingConfigured,
  GeocodeUnavailableError,
} from './client/googleClient.js';
import { addressKey } from './address.js';
import { ensureCacheTable, getUsableCache, saveCache } from './geocodeCache.js';
import logger from '../logger.js';

const PAUSE_ON_ERROR_MS = 15 * 60 * 1000;
const RETRY_FAILED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

let pausedUntil = 0;
let cacheReady = false;

function getCacheDb() {
  const db = SqliteConnection.getConnection();
  if (!cacheReady) {
    // Migration 22 creates the table; this covers fresh databases opened
    // before the migration runner has been invoked (e.g. tests).
    ensureCacheTable(db);
    cacheReady = true;
  }
  return db;
}

function readCache(key) {
  try {
    return getUsableCache(getCacheDb(), key, RETRY_FAILED_AFTER_MS);
  } catch (error) {
    logger.warn('Geocode cache read failed:', error);
    return null;
  }
}

function writeCache(entry) {
  try {
    saveCache(getCacheDb(), entry);
  } catch (error) {
    logger.warn('Geocode cache write failed:', error);
  }
}

/**
 * Geocodes an address using Google Geocoding with a shared persistent cache,
 * falling back to the upstream Nominatim flow when no Google API key is set.
 *
 * @param {string} address - The address to geocode.
 * @returns {Promise<{lat: number, lng: number}|null>} The geocoordinates or null if unavailable. {lat: -1, lng: -1} if not found.
 */
export async function geocodeAddress(address) {
  if (!address) {
    return null;
  }

  if (!isGoogleGeocodingConfigured()) {
    return nominatimGeocodeAddress(address);
  }

  const key = addressKey(address);
  const cached = readCache(key);
  if (cached) {
    return cached.status === 'ok' ? { lat: cached.latitude, lng: cached.longitude } : { lat: -1, lng: -1 };
  }

  if (isGeocodingPaused()) {
    return null;
  }

  try {
    const result = await googleGeocodeAddress(address);
    if (result) {
      writeCache({
        addressKey: key,
        sourceAddress: address,
        status: 'ok',
        latitude: result.lat,
        longitude: result.lng,
        accuracy: result.accuracy,
        placeId: result.placeId,
        formattedAddress: result.formattedAddress,
        error: null,
      });
      return { lat: result.lat, lng: result.lng };
    }
    writeCache({
      addressKey: key,
      sourceAddress: address,
      status: 'failed',
      latitude: null,
      longitude: null,
      accuracy: 'failed',
      placeId: null,
      formattedAddress: null,
      error: 'No acceptable Google geocoding result',
    });
    return { lat: -1, lng: -1 };
  } catch (error) {
    pausedUntil = Date.now() + PAUSE_ON_ERROR_MS;
    if (error instanceof GeocodeUnavailableError) {
      logger.error(`Google geocoding unavailable, pausing for ${PAUSE_ON_ERROR_MS / 60000} minutes:`, error);
    } else {
      logger.error('Unexpected error during Google geocoding, pausing:', error);
    }
    return null;
  }
}

/**
 * Upstream geocoding flow: coordinates already stored for the same address,
 * then Nominatim.
 *
 * @param {string} address
 * @returns {Promise<{lat: number, lng: number}|null>}
 */
async function nominatimGeocodeAddress(address) {
  try {
    const cachedCoordinates = getGeocoordinatesByAddress(address);
    if (cachedCoordinates) {
      logger.debug(`Found cached geocoordinates for address: ${address}`);
      return cachedCoordinates;
    }
    return await nominatimGeocode(address);
  } catch (error) {
    logger.error('Error during geocoding:', error);
    return null;
  }
}

/**
 * The geocoding cron checks this between listings; pausing after an
 * unavailable Google response keeps the cron from hammering a broken key.
 *
 * @returns {boolean}
 */
export function isGeocodingPaused() {
  if (!isGoogleGeocodingConfigured()) {
    return isNominatimPaused();
  }
  return Date.now() < pausedUntil;
}
