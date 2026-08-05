/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function quantile(values, q) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function weightedQuantile(points, q) {
  const rows = points.filter(
    (point) => Number.isFinite(point.value) && Number.isFinite(point.weight) && point.weight > 0,
  );
  if (!rows.length) return null;
  rows.sort((a, b) => a.value - b.value);
  const total = rows.reduce((sum, point) => sum + point.weight, 0);
  let seen = 0;
  for (const point of rows) {
    seen += point.weight;
    if (seen >= total * q) return point.value;
  }
  return rows.at(-1).value;
}

export function effectiveSampleSize(points) {
  const rows = points.filter((point) => Number.isFinite(point.weight) && point.weight > 0);
  if (!rows.length) return 0;
  const sum = rows.reduce((total, point) => total + point.weight, 0);
  const sumSquares = rows.reduce((total, point) => total + point.weight ** 2, 0);
  return sumSquares > 0 ? sum ** 2 / sumSquares : 0;
}

export function medianAbsoluteDeviation(values) {
  const center = median(values);
  if (center == null) return null;
  return median(values.filter(Number.isFinite).map((value) => Math.abs(value - center)));
}

export function gaussianWeight(distanceM, bandwidthM) {
  return Math.exp(-0.5 * (distanceM / bandwidthM) ** 2);
}

export function errorStats(pairs) {
  const percentageErrors = pairs
    .filter((pair) => Number.isFinite(pair.actual) && Number.isFinite(pair.predicted) && pair.actual > 0)
    .map((pair) => Math.abs(pair.predicted - pair.actual) / pair.actual);
  if (!percentageErrors.length) return { mdape: null, ppe10: null };
  return {
    mdape: roundMetric(100 * (median(percentageErrors) ?? 0)),
    ppe10: roundMetric((100 * percentageErrors.filter((error) => error <= 0.1).length) / percentageErrors.length),
  };
}

export function roundMetric(value) {
  return Number.isFinite(value) ? Math.round(value * 1000000) / 1000000 : null;
}

export function stringHash(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(hash);
}
