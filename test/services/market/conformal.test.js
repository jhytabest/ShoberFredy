/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import {
  calibrateConformal,
  conformalIntervalLog,
  conformalQuantile,
  assessConformal,
  coordQualityTier,
  MIN_POOLED_CALIBRATION_ROWS,
} from '../../../lib/services/market/conformal.js';
import { rng } from './syntheticCorpus.js';

function gaussianRows(n, seed, tier = 'trusted', sd = 0.1) {
  const random = rng(seed);
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const gauss = Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random());
    rows.push({ tier, predLog: 2.5, yLog: 2.5 + sd * gauss });
  }
  return rows;
}

describe('conformal calibration', () => {
  it('coordQualityTier maps accuracies and missing coordinates', () => {
    expect(coordQualityTier('house', true)).toBe('trusted');
    expect(coordQualityTier('street', true)).toBe('trusted');
    expect(coordQualityTier('postcode', true)).toBe('coarse');
    expect(coordQualityTier(null, true)).toBe('coarse');
    expect(coordQualityTier('house', false)).toBe('missing');
  });

  it('conformalQuantile applies the finite-sample correction', () => {
    // n=9, p=0.9 → rank ceil(10*0.9)=9 → the 9th of 9 values.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(conformalQuantile(values, 0.9)).toBe(9);
    // Too few samples for the level → null instead of an invented bound.
    expect(conformalQuantile([1, 2, 3], 0.9)).toBeNull();
  });

  it('returns null below the minimum pooled calibration size', () => {
    const rows = gaussianRows(MIN_POOLED_CALIBRATION_ROWS - 1, 7);
    expect(calibrateConformal({ mode: 'residual', level: 0.8, rows })).toBeNull();
  });

  it('residual-mode intervals achieve target coverage on fresh data', () => {
    const calibration = calibrateConformal({ mode: 'residual', level: 0.8, rows: gaussianRows(500, 11) });
    expect(calibration).not.toBeNull();
    const fresh = gaussianRows(1000, 99);
    let covered = 0;
    for (const row of fresh) {
      const interval = conformalIntervalLog(calibration, 'trusted', { predLog: row.predLog });
      expect(interval.loLog).toBeLessThan(interval.hiLog);
      if (row.yLog >= interval.loLog && row.yLog <= interval.hiLog) covered += 1;
    }
    expect(covered / fresh.length).toBeGreaterThan(0.74);
    expect(covered / fresh.length).toBeLessThan(0.88);
  });

  it('cqr mode widens undercovering quantile bands', () => {
    // Predicted band [predLog-0.01, predLog+0.01] is far too narrow for sd=0.1.
    const rows = gaussianRows(400, 21).map((row) => ({
      ...row,
      loLog: row.predLog - 0.01,
      hiLog: row.predLog + 0.01,
    }));
    const calibration = calibrateConformal({ mode: 'cqr', level: 0.8, rows });
    expect(calibration.pooled.adjustment).toBeGreaterThan(0.05);
    const interval = conformalIntervalLog(calibration, 'trusted', { loLog: 2.49, hiLog: 2.51 });
    expect(interval.hiLog - interval.loLog).toBeGreaterThan(0.1);
  });

  it('small tiers fall back to the pooled calibration; large tiers get their own', () => {
    const rows = [...gaussianRows(200, 31, 'trusted', 0.05), ...gaussianRows(200, 32, 'coarse', 0.2)];
    const calibration = calibrateConformal({ mode: 'residual', level: 0.8, rows });
    expect(calibration.tiers.trusted).toBeDefined();
    expect(calibration.tiers.coarse).toBeDefined();
    // The noisier tier must earn a wider interval.
    const trusted = conformalIntervalLog(calibration, 'trusted', { predLog: 0 });
    const coarse = conformalIntervalLog(calibration, 'coarse', { predLog: 0 });
    expect(coarse.hiLog - coarse.loLog).toBeGreaterThan(trusted.hiLog - trusted.loLog);
    // Unknown tier → pooled fallback, never null while pooled exists.
    expect(conformalIntervalLog(calibration, 'missing', { predLog: 0 })).not.toBeNull();
  });

  it('assessConformal measures on held-out rows, not the calibration half', () => {
    const report = assessConformal({ mode: 'residual', level: 0.8, rows: gaussianRows(600, 41) });
    expect(report.assessed).toBeGreaterThan(200);
    expect(report.coverage).toBeGreaterThan(0.7);
    expect(report.coverage).toBeLessThan(0.92);
    expect(report.medianWidthPercent).toBeGreaterThan(0);
  });
});
