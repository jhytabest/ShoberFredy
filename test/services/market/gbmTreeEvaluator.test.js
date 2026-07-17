/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { prepareModel, predictRow } from '../../../lib/services/market/models/gbmTreeEvaluator.js';

const dump = JSON.parse(
  await readFile(new URL('../../testFixtures/market/gbm_dump_model.json', import.meta.url), 'utf8'),
);
const { X, expected } = JSON.parse(
  await readFile(new URL('../../testFixtures/market/gbm_dump_expected.json', import.meta.url), 'utf8'),
);

describe('gbmTreeEvaluator', () => {
  it('matches booster.predict() exactly on a real LightGBM dump (incl. NaN rows)', () => {
    // Fixture: quantile-objective booster trained on data with missing rooms
    // and coordinates; expected values come straight from Python's predict().
    const model = prepareModel(dump);
    X.forEach((row, index) => {
      const features = row.map((value) => (value == null ? Number.NaN : value));
      expect(predictRow(model, features)).toBeCloseTo(expected[index], 9);
    });
  });

  it('rejects payloads that are not LightGBM dumps', () => {
    expect(() => prepareModel({})).toThrow(/dump_model/);
    expect(() => prepareModel(null)).toThrow(/dump_model/);
  });

  it('rejects categorical splits instead of mis-evaluating them', () => {
    const categorical = {
      tree_info: [
        {
          tree_structure: {
            split_feature: 0,
            decision_type: '==',
            threshold: '0||1',
            default_left: true,
            left_child: { leaf_value: 1 },
            right_child: { leaf_value: 2 },
          },
        },
      ],
    };
    expect(() => prepareModel(categorical)).toThrow(/decision_type/);
  });

  it('routes missing values per missing_type semantics', () => {
    const node = (missingType) => ({
      tree_info: [
        {
          tree_structure: {
            split_feature: 0,
            decision_type: '<=',
            threshold: 10,
            default_left: false,
            missing_type: missingType,
            left_child: { leaf_value: 1 },
            right_child: { leaf_value: 2 },
          },
        },
      ],
    });
    // NaN with missing_type None → coerced to 0 → 0 <= 10 → left leaf.
    expect(predictRow(prepareModel(node('None')), [Number.NaN])).toBe(1);
    // NaN with missing_type NaN → default direction (right).
    expect(predictRow(prepareModel(node('NaN')), [Number.NaN])).toBe(2);
    // 0 with missing_type Zero → default direction (right).
    expect(predictRow(prepareModel(node('Zero')), [0])).toBe(2);
    // Ordinary numeric comparison still works.
    expect(predictRow(prepareModel(node('None')), [11])).toBe(2);
  });
});
