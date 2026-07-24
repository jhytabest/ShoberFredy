/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Shared evaluation harness for the market models.
 *
 * Both models are judged on the SAME spatially-blocked, cluster-cohesive
 * folds and the same metrics — MdAPE and PPE10 for the point estimate,
 * conformal coverage and median interval width for the intervals — so their
 * eval_json rows in homeserver_model_runs are directly comparable.
 *
 * Folds are blocked by 500m grid cell (rows without coordinates block by
 * their duplicate cluster), so a flat can never be predicted from its own
 * building. Fold assignment is deterministic per salt; different salts give
 * independent fold layouts for hyper-parameter selection vs conformal
 * calibration, so the calibration never sees folds tuned on themselves.
 */

import { gridKey } from './geo.js';
import { stringHash, median, errorStats, roundMetric } from './stats.js';
import { assessConformal } from './conformal.js';

const DEFAULT_FOLD_COUNT = 5;
const FOLD_CELL_M = 500;

/**
 * Deterministic spatially-blocked fold assignment.
 *
 * @param {object[]} rows corpus rows (need hasCoords, x, y, clusterId)
 * @param {{foldCount?: number, cellM?: number, salt?: string}} [options]
 * @returns {number[]} fold index per row, aligned with rows
 */
export function assignFolds(rows, options = {}) {
  const foldCount = options.foldCount ?? DEFAULT_FOLD_COUNT;
  const cellM = options.cellM ?? FOLD_CELL_M;
  const salt = options.salt ?? '';
  return rows.map((row) => {
    const key = row.hasCoords ? `c:${gridKey(row.x, row.y, cellM)}` : `s:${row.clusterId}`;
    return stringHash(`${key}|${salt}`) % foldCount;
  });
}

/**
 * Baseline every model has to beat: predict the global median €/m².
 * @param {object[]} rows training rows (need pricePerSqm)
 * @returns {{mdape: number|null, ppe10: number|null, n: number}}
 */
function naivePointStats(rows) {
  const center = median(rows.map((row) => row.pricePerSqm));
  return {
    ...errorStats(rows.map((row) => ({ actual: row.pricePerSqm, predicted: center }))),
    n: rows.length,
  };
}

/**
 * Full evaluation report from out-of-fold predictions.
 *
 * @param {object} options
 * @param {{actual: number, predicted: number}[]} options.pairs OOF point
 *   predictions in €/m²
 * @param {Array<object>} options.conformalRows OOF rows in the
 *   calibrateConformal shape ({tier, yLog, predLog?/loLog?/hiLog?})
 * @param {'residual'|'cqr'} options.mode
 * @param {number} options.level target coverage
 * @param {object[]} options.trainingRows for the naive baseline
 * @returns {object} serializable eval report
 */
export function buildEvalReport({ pairs, conformalRows, mode, level, trainingRows }) {
  const interval = assessConformal({ mode, level, rows: conformalRows });
  return {
    point: { ...errorStats(pairs), n: pairs.length },
    interval: {
      level,
      coverage: roundMetric(interval.coverage),
      medianWidthPercent: roundMetric(interval.medianWidthPercent),
      assessed: interval.assessed,
    },
    naive: naivePointStats(trainingRows),
  };
}
