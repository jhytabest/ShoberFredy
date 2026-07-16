/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  trainGbmModel,
  prepareGbmArtifact,
  predictGbmLog,
  scoreGbmCorpusRow,
  GBM_VERSION,
} from '../../../lib/services/market/models/gbmModel.js';
import { gbmFeatureNames, gbmFeatureVector } from '../../../lib/services/scoring/hedonicFeatures.js';
import { syntheticRows, trueLogPricePerSqm } from './syntheticCorpus.js';

const pythonBin = process.env.FREDY_PYTHON_BIN || 'python3';
const lightgbmAvailable = (() => {
  try {
    execFileSync(pythonBin, ['-c', 'import lightgbm, numpy'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Fast trainer settings: one grid point, capped boosting rounds.
const trainerOverrides = { numLeavesGrid: [7], minDataGrid: [10], halfLifeGrid: [90], maxRounds: 150 };

describe('gbmModel', () => {
  it('returns null when the python binary does not exist (no throw, no artifact)', async () => {
    const { rows } = syntheticRows(60, { seed: 3 });
    const result = await trainGbmModel({
      trainingRows: rows,
      now: 1750000000000,
      level: 0.8,
      pythonBin: '/nonexistent/python3',
    });
    expect(result).toBeNull();
  });

  it('returns null below the minimum corpus size', async () => {
    const { rows } = syntheticRows(10, { seed: 4 });
    expect(await trainGbmModel({ trainingRows: rows, now: 1, level: 0.8 })).toBeNull();
  });

  describe.skipIf(!lightgbmAvailable)('with LightGBM available', () => {
    it('trains, calibrates, beats the naive baseline and predicts sanely', async () => {
      const { rows } = syntheticRows(260, { seed: 5 });
      const result = await trainGbmModel({
        trainingRows: rows,
        now: 1750000000000,
        level: 0.8,
        pythonBin,
        trainerOverrides,
      });
      expect(result).not.toBeNull();
      const { artifact, evaluation } = result;

      expect(artifact.version).toBe(GBM_VERSION);
      expect(artifact.featureNames).toEqual(gbmFeatureNames());
      expect(artifact.boosters.lo).toBeDefined();
      expect(artifact.boosters.mid).toBeDefined();
      expect(artifact.boosters.hi).toBeDefined();
      expect(artifact.conformal).not.toBeNull();
      expect(artifact.params.half_life_days).toBe(90);

      expect(evaluation.point.mdape).toBeLessThan(evaluation.naive.mdape);
      expect(evaluation.interval.coverage).toBeGreaterThan(0.6);

      // Fresh listing near the middle of the synthetic surface.
      const { rows: fresh } = syntheticRows(40, { seed: 999, missingCoordsShare: 0 });
      const prepared = prepareGbmArtifact(artifact);
      const errors = fresh.map((row) => {
        const raw = predictGbmLog(prepared, gbmFeatureVector({ ...row, ageDays: 0 }));
        expect(raw.loLog).toBeLessThanOrEqual(raw.midLog);
        expect(raw.midLog).toBeLessThanOrEqual(raw.hiLog);
        return Math.abs(Math.exp(raw.midLog) - Math.exp(trueLogPricePerSqm(row.size, row.longitude)));
      });
      const median = errors.sort((a, b) => a - b)[Math.floor(errors.length / 2)];
      expect(median).toBeLessThan(1.5); // true surface ≈ 12 €/m²

      // Missing-value handling: a coordinate-less listing still predicts.
      const noCoords = { ...fresh[0], latitude: null, longitude: null, geocodeQuality: null };
      const raw = predictGbmLog(prepared, gbmFeatureVector({ ...noCoords, ageDays: 0 }));
      expect(Number.isFinite(raw.midLog)).toBe(true);

      // Batch score shape for homeserver_listing_market_model.
      const score = scoreGbmCorpusRow(fresh[0], prepared, artifact);
      expect(score.predictedPricePerSqm).toBeGreaterThan(5);
      expect(score.predictedLoPricePerSqm).toBeLessThan(score.predictedHiPricePerSqm);
      expect(score.zScore).toBeNull();
      expect(score.confidence).toBeNull();
    }, 240000);
  });
});
