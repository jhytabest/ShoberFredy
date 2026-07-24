/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Split-conformal calibration shared by both market models.
 *
 * Both models produce out-of-fold predictions during their cross-validation
 * pass; those OOF predictions are the calibration set. Intervals are
 * "Mondrian": calibrated separately per coordinate-quality tier (trusted
 * geocode / coarse geocode / missing coordinates), so a listing whose
 * location is only known to postcode precision automatically gets the wider
 * interval its comparables actually justify. Tiers below the minimum
 * calibration size fall back to the pooled calibration; if even the pooled
 * set is too small, calibration is null and the scorer omits the interval
 * (point estimate only) instead of inventing one.
 *
 * Two modes:
 * - 'residual' (ridge): nonconformity is the signed log residual
 *   y − ŷ; the interval is ŷ + [Q_lo, Q_hi] with finite-sample-corrected
 *   empirical quantiles. Asymmetric by construction.
 * - 'cqr' (GBM): conformalized quantile regression. Nonconformity is
 *   E = max(q_lo − y, y − q_hi); the calibrated interval is
 *   [q_lo − E*, q_hi + E*] with E* the finite-sample quantile of E.
 *
 * Everything operates in log space; exponentiation happens in the scorer.
 */

import { quantile } from './stats.js';

/** Minimum calibration rows for a tier before falling back to pooled. */
const MIN_TIER_CALIBRATION_ROWS = 30;
/** Minimum pooled calibration rows before giving up on intervals. */
const MIN_POOLED_CALIBRATION_ROWS = 20;

const TRUSTED_ACCURACIES = new Set(['house', 'street']);

/**
 * Coordinate-quality tier of a listing (Mondrian bucket key).
 * @param {string|null} geocodeQuality accuracy from the geocode cache
 * @param {boolean} hasCoordinates
 * @returns {'trusted'|'coarse'|'missing'}
 */
export function coordQualityTier(geocodeQuality, hasCoordinates) {
  if (!hasCoordinates) return 'missing';
  return TRUSTED_ACCURACIES.has(geocodeQuality) ? 'trusted' : 'coarse';
}

/**
 * Finite-sample-corrected upper empirical quantile used by split conformal:
 * the ceil((n+1) * p)-th order statistic. Returns null when the correction
 * exceeds the sample (not enough data for the requested level).
 *
 * @param {number[]} values
 * @param {number} p target probability in (0, 1)
 * @returns {number|null}
 */
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

/**
 * Calibrate Mondrian split-conformal intervals from out-of-fold rows.
 *
 * @param {object} options
 * @param {'residual'|'cqr'} options.mode
 * @param {number} options.level target two-sided coverage, e.g. 0.8
 * @param {Array<{tier: string, yLog: number, predLog?: number, loLog?: number, hiLog?: number}>} options.rows
 * @returns {{mode: string, level: number, tiers: Record<string, object>, pooled: object|null}|null}
 *   null when even the pooled calibration set is too small.
 */
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

/**
 * Apply a calibration to one prediction, in log space.
 *
 * @param {object|null} calibration output of calibrateConformal
 * @param {string} tier coordQualityTier of the listing being scored
 * @param {{predLog?: number, loLog?: number, hiLog?: number}} prediction
 * @returns {{loLog: number, hiLog: number}|null} null when uncalibrated
 */
export function conformalIntervalLog(calibration, tier, prediction) {
  if (!calibration) return null;
  const params = calibration.tiers[tier] ?? calibration.pooled;
  if (!params) return null;
  if (calibration.mode === 'cqr') {
    return { loLog: prediction.loLog - params.adjustment, hiLog: prediction.hiLog + params.adjustment };
  }
  return { loLog: prediction.predLog + params.lo, hiLog: prediction.predLog + params.hi };
}

/**
 * Honest coverage assessment: calibrate on one half of the rows, measure
 * coverage and width on the other half (measuring on the calibration rows
 * would return the target level by construction). The production calibration
 * should afterwards be fitted on ALL rows.
 *
 * @param {object} options same as calibrateConformal
 * @returns {{coverage: number|null, medianWidthPercent: number|null, assessed: number}}
 */
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
