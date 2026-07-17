/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import {
  trainRidgeModel,
  buildSurfaceCells,
  choleskySolve,
  RIDGE_VERSION,
} from '../../../lib/services/market/models/ridgeModel.js';
import { hedonicTermNames } from '../../../lib/services/scoring/hedonicFeatures.js';
import { syntheticRows, trueLogPricePerSqm } from './syntheticCorpus.js';

describe('choleskySolve', () => {
  it('solves a known positive-definite system', () => {
    const a = [
      [4, 2],
      [2, 3],
    ];
    const b = [10, 8];
    const x = choleskySolve(a, b);
    expect(x[0]).toBeCloseTo(1.75, 10);
    expect(x[1]).toBeCloseTo(1.5, 10);
  });

  it('throws on an indefinite system instead of zeroing silently', () => {
    // Eigenvalues 3 and -1: not positive definite, beyond jitter rescue.
    const indefinite = [
      [1, 2],
      [2, 1],
    ];
    expect(() => choleskySolve(indefinite, [1, 2])).toThrow(/positive definite/);
  });

  it('rescues a semi-definite system via the jitter retry (ridge-like behavior)', () => {
    const semiDefinite = [
      [1, 1],
      [1, 1],
    ];
    const x = choleskySolve(semiDefinite, [2, 2]);
    expect(x[0] + x[1]).toBeCloseTo(2, 5);
  });
});

describe('ridgeModel', () => {
  const { rows, projection } = syntheticRows(300, { seed: 42 });
  const trained = trainRidgeModel({ trainingRows: rows, projection, now: 1750000000000, level: 0.8 });

  it('returns null on a corpus too small to trust', () => {
    expect(trainRidgeModel({ trainingRows: rows.slice(0, 10), projection, now: 1750000000000, level: 0.8 })).toBeNull();
  });

  it('produces an artifact aligned with the current feature space', () => {
    expect(trained).not.toBeNull();
    const { artifact } = trained;
    expect(artifact.version).toBe(RIDGE_VERSION);
    expect(artifact.beta).toHaveLength(hedonicTermNames().length);
    expect(artifact.means).toHaveLength(artifact.beta.length);
    expect(artifact.stds).toHaveLength(artifact.beta.length);
    expect(artifact.lambda).toBeGreaterThan(0);
    expect(artifact.halfLifeDays).toBeGreaterThan(0);
    expect(artifact.projection.referenceLatitude).toBeCloseTo(52.5, 5);
    expect(artifact.conformal).not.toBeNull();
    expect(artifact.trainingLogBand.lo).toBeLessThan(artifact.trainingLogBand.hi);
  });

  it('beats the naive baseline and reports honest interval quality', () => {
    const { evaluation } = trained;
    expect(evaluation.point.mdape).toBeLessThan(evaluation.naive.mdape);
    expect(evaluation.interval.coverage).toBeGreaterThan(0.6);
    expect(evaluation.interval.coverage).toBeLessThanOrEqual(1);
    expect(evaluation.interval.medianWidthPercent).toBeGreaterThan(0);
  });

  it('recovers ground truth within tolerance on fresh listings', () => {
    const { rows: fresh } = syntheticRows(60, { seed: 777, missingCoordsShare: 0 });
    const errors = fresh.map((row) => {
      const { predLog } = trained.model.predictRow(row);
      return Math.abs(Math.exp(predLog) - Math.exp(trueLogPricePerSqm(row.size, row.longitude)));
    });
    const median = errors.sort((a, b) => a - b)[Math.floor(errors.length / 2)];
    // True surface is ~12 €/m²; the model should locate it within ~8%.
    expect(median).toBeLessThan(1);
  });

  it('scores rows without coordinates via the hedonic-only path', () => {
    const noCoords = rows.find((row) => !row.hasCoords);
    expect(noCoords).toBeDefined();
    const score = trained.model.scoreCorpusRow(noCoords);
    expect(score.predictedPricePerSqm).toBeGreaterThan(5);
    expect(score.predictedPricePerSqm).toBeLessThan(30);
    expect(score.nearbyComps500m).toBe(0);
    // Interval exists (missing tier falls back to pooled at worst).
    expect(score.predictedLoPricePerSqm).toBeLessThan(score.predictedHiPricePerSqm);
  });

  it('batch scores carry ordered conformal bounds and finite deltas', () => {
    const score = trained.model.scoreCorpusRow(rows[0]);
    expect(score.predictedLoPricePerSqm).toBeLessThan(score.predictedPricePerSqm * 1.05);
    expect(score.predictedHiPricePerSqm).toBeGreaterThan(score.predictedPricePerSqm * 0.95);
    expect(Number.isFinite(score.deltaPercent)).toBe(true);
    expect(Number.isFinite(score.zScore)).toBe(true);
  });

  it('builds surface cells around the training data', () => {
    const cells = buildSurfaceCells(trained.model, rows, projection, 0.05);
    expect(cells.length).toBeGreaterThan(10);
    const cell = cells[0];
    expect(cell.predictedPricePerSqm).toBeGreaterThan(3);
    expect(cell.centerLatitude).toBeGreaterThan(52);
    expect(JSON.parse(cell.surfaceComponentsJson)).toHaveProperty('residualLog');
  });
});
