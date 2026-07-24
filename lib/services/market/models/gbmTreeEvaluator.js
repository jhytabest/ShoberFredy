/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Pure-JS evaluator for LightGBM dump_model() JSON.
 *
 * The GBM market model is trained by tools/market/train_gbm.py (a
 * short-lived batch process) but SCORED here, in-process, at notify time —
 * no Python at scrape time, no native dependencies. A prediction is the sum
 * of one leaf value per tree.
 *
 * Missing-value routing mirrors LightGBM's Tree::NumericalDecision exactly:
 * - missing_type 'NaN'  → NaN takes the node's default_left direction;
 * - missing_type 'Zero' → NaN is coerced to 0, and 0 takes the default;
 * - missing_type 'None' → NaN is coerced to 0 and compared normally.
 * Only numerical splits ('<=') are supported; the trainer never emits
 * categorical splits because every feature in gbmFeatureVector is numeric.
 *
 * Verified bit-exact against booster.predict() in
 * using a dump generated
 * by a real LightGBM training run.
 */

const EPSILON = 1e-35;

/**
 * Prepare a dumped model for fast evaluation (validates split types once).
 *
 * @param {object} dump booster.dump_model() JSON
 * @returns {{trees: object[], numFeatures: number}}
 */
export function prepareModel(dump) {
  if (!dump || !Array.isArray(dump.tree_info)) {
    throw new Error('not a LightGBM dump_model payload');
  }
  for (const tree of dump.tree_info) {
    validateNode(tree.tree_structure);
  }
  return { trees: dump.tree_info.map((tree) => tree.tree_structure), numFeatures: (dump.max_feature_idx ?? 0) + 1 };
}

function validateNode(node) {
  if (node.leaf_value !== undefined && node.split_feature === undefined) return;
  if (node.decision_type !== '<=') {
    throw new Error(`unsupported split decision_type '${node.decision_type}' (only numerical '<=' splits)`);
  }
  validateNode(node.left_child);
  validateNode(node.right_child);
}

/**
 * Predict one row: sum of leaf values across all trees.
 *
 * @param {{trees: object[]}} model prepareModel output
 * @param {number[]} features numeric feature vector; NaN marks missing
 * @returns {number}
 */
export function predictRow(model, features) {
  let sum = 0;
  for (const root of model.trees) {
    let node = root;
    while (node.split_feature !== undefined) {
      node = decide(node, features[node.split_feature]) ? node.left_child : node.right_child;
    }
    sum += node.leaf_value;
  }
  return sum;
}

/** @returns {boolean} true → go left */
function decide(node, rawValue) {
  let value = rawValue;
  const missingType = node.missing_type;
  if (Number.isNaN(value) && missingType !== 'NaN') value = 0;
  if (missingType === 'Zero') {
    if (Math.abs(value) <= EPSILON) return node.default_left;
  } else if (missingType === 'NaN') {
    if (Number.isNaN(value)) return node.default_left;
  }
  return value <= node.threshold;
}
