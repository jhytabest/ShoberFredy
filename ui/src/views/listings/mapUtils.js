/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Calculates the bounding box for a set of coordinates.
 *
 * @param {number[][]} coords - Array of [longitude, latitude] coordinates
 * @param {number} [padding=0.1] - Padding to add to the bounds
 * @returns {number[][]} Bounding box coordinates [[minLon, minLat], [maxLon, maxLat]]
 */
export const getBoundsFromCoords = (coords, padding = 0.1) => {
  if (!coords || coords.length === 0) return null;

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  coords.forEach(([lng, lat]) => {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  });

  const lngDiff = maxLng - minLng;
  const latDiff = maxLat - minLat;

  return [
    [minLng - lngDiff * padding, minLat - latDiff * padding],
    [maxLng + lngDiff * padding, maxLat + latDiff * padding],
  ];
};
