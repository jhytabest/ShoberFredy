/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { gridKey } from './geo.js';
import { stringHash, median, errorStats, roundMetric } from './stats.js';
import { assessConformal } from './conformal.js';

const DEFAULT_FOLD_COUNT = 5;
const FOLD_CELL_M = 500;

export function assignFolds(rows, options = {}) {
  const foldCount = options.foldCount ?? DEFAULT_FOLD_COUNT;
  const cellM = options.cellM ?? FOLD_CELL_M;
  const salt = options.salt ?? '';
  return rows.map((row) => {
    const key = row.hasCoords ? `c:${gridKey(row.x, row.y, cellM)}` : `s:${row.clusterId}`;
    return stringHash(`${key}|${salt}`) % foldCount;
  });
}

function naivePointStats(rows) {
  const center = median(rows.map((row) => row.pricePerSqm));
  return {
    ...errorStats(rows.map((row) => ({ actual: row.pricePerSqm, predicted: center }))),
    n: rows.length,
  };
}

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
