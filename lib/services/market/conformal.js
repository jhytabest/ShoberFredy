/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { quantile } from './stats.js';

const MIN_TIER_CALIBRATION_ROWS = 30;
const MIN_POOLED_CALIBRATION_ROWS = 20;

const TRUSTED_ACCURACIES = new Set(['house', 'street']);

export const EMPTY_FIELD_CONFIDENCE = 0.05;

const COARSE_GEOCODE_PENALTY = 0.75;

export function coordQualityTier(geocodeQuality, hasCoordinates) {
  if (!hasCoordinates) return 'missing';
  return TRUSTED_ACCURACIES.has(geocodeQuality) ? 'trusted' : 'coarse';
}

// A district-centroid geocode places a flat to the neighbourhood, not the
// building, so the local surface says less about it than the number suggests.
export function geocodePenaltyFor(tier) {
  return tier === 'trusted' ? 1 : COARSE_GEOCODE_PENALTY;
}

function conformalQuantile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return null;
  const rank = Math.ceil((n + 1) * p);
  if (rank > n) return null;
  return sorted[rank - 1];
}

function residualOffsets(residuals, level) {
  const alphaSide = (1 - level) / 2;
  const lo = conformalQuantile(
    residuals.map((r) => -r),
    1 - alphaSide,
  );
  const hi = conformalQuantile(residuals, 1 - alphaSide);
  if (lo == null || hi == null) return null;
  return { lo: -lo, hi, n: residuals.length };
}

function cqrAdjustment(errors, level) {
  const adjustment = conformalQuantile(errors, level);
  if (adjustment == null) return null;
  return { adjustment, n: errors.length };
}

export function calibrateConformal({ mode, level, rows }) {
  const usable = rows.filter((row) => Number.isFinite(row.yLog));
  if (usable.length < MIN_POOLED_CALIBRATION_ROWS) return null;

  const scoreOf =
    mode === 'cqr' ? (row) => Math.max(row.loLog - row.yLog, row.yLog - row.hiLog) : (row) => row.yLog - row.predLog;
  const fit = (subset) => {
    const values = subset.map(scoreOf).filter(Number.isFinite);
    return mode === 'cqr' ? cqrAdjustment(values, level) : residualOffsets(values, level);
  };

  const pooled = fit(usable);
  if (!pooled) return null;

  const tiers = {};
  const byTier = new Map();
  for (const row of usable) {
    const tier = row.tier || 'coarse';
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier).push(row);
  }
  for (const [tier, subset] of byTier) {
    if (subset.length < MIN_TIER_CALIBRATION_ROWS) continue;
    const fitted = fit(subset);
    if (fitted) tiers[tier] = fitted;
  }

  return { mode, level, tiers, pooled };
}

export function conformalIntervalLog(calibration, tier, prediction) {
  if (!calibration) return null;
  const params = calibration.tiers[tier] ?? calibration.pooled;
  if (!params) return null;
  if (calibration.mode === 'cqr') {
    return { loLog: prediction.loLog - params.adjustment, hiLog: prediction.hiLog + params.adjustment };
  }
  return { loLog: prediction.predLog + params.lo, hiLog: prediction.predLog + params.hi };
}

export function assessConformal({ mode, level, rows }) {
  const usable = rows.filter((row) => Number.isFinite(row.yLog));
  const calibrationHalf = usable.filter((row, index) => index % 2 === 0);
  const assessmentHalf = usable.filter((row, index) => index % 2 === 1);
  const calibration = calibrateConformal({ mode, level, rows: calibrationHalf });
  if (!calibration || !assessmentHalf.length) {
    return { coverage: null, medianWidthPercent: null, assessed: 0 };
  }
  let covered = 0;
  const widths = [];
  for (const row of assessmentHalf) {
    const interval = conformalIntervalLog(calibration, row.tier || 'coarse', row);
    if (!interval) continue;
    if (row.yLog >= interval.loLog && row.yLog <= interval.hiLog) covered += 1;
    widths.push(100 * (Math.exp(interval.hiLog - interval.loLog) - 1));
  }
  if (!widths.length) return { coverage: null, medianWidthPercent: null, assessed: 0 };
  return {
    coverage: covered / widths.length,
    medianWidthPercent: quantile(widths, 0.5),
    assessed: widths.length,
  };
}
