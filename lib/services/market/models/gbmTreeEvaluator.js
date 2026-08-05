/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const EPSILON = 1e-35;

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
