/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Shoberfredy geocoding service — Google Geocoding only.
 *
 * Addresses are geocoded via Google with a persistent cache
 * (homeserver_geocode_cache) shared with the backfill CLI
 * (tools/market/geocoderBackfill.js), the cross-portal dedupe, the market
 * scorer, the market model, and the metrics exporter. Without an API key the
 * service reports "unavailable" and the pipeline aborts before saving any
 * listing from the current provider batch.
 *
 * Return contract (relied on by the spatial filter in
 * FredyPipelineExecutioner):
 *   {lat, lng}   — geocoded successfully
 *   {-1, -1}     — the geocoder answered and the address is definitively not found
 *   null         — the geocoder could not be asked (no key, quota, denied
 *                  key, transport); the pipeline aborts before save
 */

import SqliteConnection from '../storage/SqliteConnection.js';
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
let lastUnavailableAt = 0;
let cacheReady = false;

function getCacheDb() {
  const db = SqliteConnection.getConnection();
  if (!cacheReady) {
    // Migration 22 creates the table; this also covers fresh databases opened
    // by a standalone maintenance command before the migration runner.
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
 * Geocodes an address using Google Geocoding with a shared persistent cache.
 *
 * @param {string} address - The address to geocode.
 * @returns {Promise<{lat: number, lng: number}|null>} The geocoordinates or null if unavailable. {lat: -1, lng: -1} if not found.
 */
export async function geocodeAddress(address) {
  if (!address) {
    return null;
  }

  const key = addressKey(address);
  const cached = readCache(key);
  if (cached) {
    return cached.status === 'ok' ? { lat: cached.latitude, lng: cached.longitude } : { lat: -1, lng: -1 };
  }

  if (!isGoogleGeocodingConfigured()) {
    warnMissingKeyOnce();
    lastUnavailableAt = Date.now();
    return null;
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
    lastUnavailableAt = Date.now();
    if (error instanceof GeocodeUnavailableError) {
      logger.error(`Google geocoding unavailable, pausing for ${PAUSE_ON_ERROR_MS / 60000} minutes:`, error);
    } else {
      logger.error('Unexpected error during Google geocoding, pausing:', error);
    }
    return null;
  }
}

/**
 * Geocoding health for the metrics exporter: unhealthy while the service is
 * paused after an unavailable Google response or missing an API key.
 *
 * @returns {{healthy: boolean, configured: boolean, lastUnavailableAt: number}}
 */
export function getGeocodingHealth() {
  const configured = isGoogleGeocodingConfigured();
  return {
    healthy: configured && !isGeocodingPaused(),
    configured,
    lastUnavailableAt,
  };
}

let warnedMissingKey = false;

function warnMissingKeyOnce() {
  if (warnedMissingKey) return;
  warnedMissingKey = true;
  logger.warn('GOOGLE_GEOCODING_API_KEY is not set — geocoding is unavailable; pipeline runs will abort before save.');
}

/**
 * Pipeline runs check this before calling Google; pausing after an unavailable
 * response keeps scheduled runs from hammering a broken key.
 *
 * @returns {boolean}
 */
function isGeocodingPaused() {
  return Date.now() < pausedUntil;
}
