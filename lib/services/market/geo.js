/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Local metric projection shared by the market models, the surface writer
 * and the notification-time scorer. An equirectangular projection around the
 * corpus is exact enough at city scale (<0.1% distortion over ~30km) and
 * keeps every distance computation a plain hypot.
 *
 * The reference latitude is DERIVED FROM THE DATA (median listing latitude)
 * at training time and persisted inside each model artifact, so nothing here
 * assumes a particular city. A fixed fallback keeps the projection defined
 * before the first training run.
 */

const METERS_PER_LATITUDE_DEGREE = 111320;

/**
 * Meters per longitude degree at the given reference latitude.
 * @param {number} referenceLatitude
 * @returns {number}
 */
function metersPerLongitudeDegree(referenceLatitude) {
  return METERS_PER_LATITUDE_DEGREE * Math.cos((referenceLatitude * Math.PI) / 180);
}

/**
 * Build a projection around a reference latitude. Returns plain functions so
 * the constants can be persisted in artifacts and rebuilt at scoring time.
 *
 * @param {number} referenceLatitude
 * @returns {{
 *   referenceLatitude: number,
 *   metersPerLatitudeDegree: number,
 *   metersPerLongitudeDegree: number,
 *   project: (latitude: number, longitude: number) => {x: number, y: number},
 *   unproject: (x: number, y: number) => {latitude: number, longitude: number},
 * }}
 */
export function buildProjection(referenceLatitude) {
  const perLat = METERS_PER_LATITUDE_DEGREE;
  const perLng = metersPerLongitudeDegree(referenceLatitude);
  return {
    referenceLatitude,
    metersPerLatitudeDegree: perLat,
    metersPerLongitudeDegree: perLng,
    project: (latitude, longitude) => ({ x: longitude * perLng, y: latitude * perLat }),
    unproject: (x, y) => ({ latitude: y / perLat, longitude: x / perLng }),
  };
}

/**
 * Grid cell key for spatial indexing.
 * @param {number} x
 * @param {number} y
 * @param {number} sizeM
 * @returns {string}
 */
export function gridKey(x, y, sizeM) {
  return `${Math.floor(x / sizeM)}:${Math.floor(y / sizeM)}`;
}
