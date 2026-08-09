/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import {
  geocodeAddress as googleGeocodeAddress,
  isGoogleGeocodingConfigured,
  GeocodeUnavailableError,
} from './client/googleClient.js';
import { addressKey } from './address.js';
import { COARSE_ACCURACY, ensureCacheTable, getCacheRow, getUsableCache, saveCache } from './geocodeCache.js';
import logger from '../logger.js';
import { env } from '../../shared/env.js';

const PAUSE_ON_ERROR_MS = 15 * 60 * 1000;
const RETRY_FAILED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_COARSE_AFTER_MS = env('FREDY_GEOCODER_RETRY_COARSE_AFTER_DAYS') * 24 * 60 * 60 * 1000;

let pausedUntil = 0;
let lastUnavailableAt = 0;
let cacheReady = false;

function getCacheDb() {
  const db = SqliteConnection.getConnection();
  if (!cacheReady) {
    ensureCacheTable(db);
    cacheReady = true;
  }
  return db;
}

function readCache(key) {
  try {
    return getUsableCache(getCacheDb(), key, RETRY_FAILED_AFTER_MS, RETRY_COARSE_AFTER_MS);
  } catch (error) {
    logger.warn('Geocode cache read failed:', error);
    return null;
  }
}

function staleCoarseCoords(key) {
  try {
    const row = getCacheRow(getCacheDb(), key);
    if (!row || row.status !== 'ok' || !COARSE_ACCURACY.has(row.accuracy)) return null;
    if (row.latitude == null || row.longitude == null) return null;
    return { lat: row.latitude, lng: row.longitude, locality: row.locality ?? null };
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

export async function geocodeAddress(address, { city = null } = {}) {
  if (!address) {
    return null;
  }

  const key = addressKey(address, city);
  const cached = readCache(key);
  if (cached) {
    return cached.status === 'ok'
      ? { lat: cached.latitude, lng: cached.longitude, locality: cached.locality ?? null }
      : { lat: -1, lng: -1, locality: null };
  }

  if (!isGoogleGeocodingConfigured()) {
    warnMissingKeyOnce();
    lastUnavailableAt = Date.now();
    return staleCoarseCoords(key);
  }

  if (isGeocodingPaused()) {
    return staleCoarseCoords(key);
  }

  try {
    const result = await googleGeocodeAddress(address, { city });
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
        locality: result.locality ?? null,
        error: null,
      });
      return { lat: result.lat, lng: result.lng, locality: result.locality ?? null };
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
      locality: null,
      error: 'No acceptable Google geocoding result',
    });
    return { lat: -1, lng: -1, locality: null };
  } catch (error) {
    pausedUntil = Date.now() + PAUSE_ON_ERROR_MS;
    lastUnavailableAt = Date.now();
    if (error instanceof GeocodeUnavailableError) {
      logger.error(`Google geocoding unavailable, pausing for ${PAUSE_ON_ERROR_MS / 60000} minutes:`, error);
    } else {
      logger.error('Unexpected error during Google geocoding, pausing:', error);
    }
    return staleCoarseCoords(key);
  }
}

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

function isGeocodingPaused() {
  return Date.now() < pausedUntil;
}
