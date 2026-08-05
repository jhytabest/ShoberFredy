/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const METERS_PER_LATITUDE_DEGREE = 111320;

function metersPerLongitudeDegree(referenceLatitude) {
  return METERS_PER_LATITUDE_DEGREE * Math.cos((referenceLatitude * Math.PI) / 180);
}

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

export function hasUsableCoordinates(latitude, longitude) {
  if (latitude == null || longitude == null) return false;
  const lat = Number(latitude);
  const lng = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat !== -1 && lng !== -1;
}

export function gridKey(x, y, sizeM) {
  return `${Math.floor(x / sizeM)}:${Math.floor(y / sizeM)}`;
}
