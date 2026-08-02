#!/usr/bin/env python3
# Copyright (c) 2026 by Christian Kellner.
# Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
#
# LightGBM quantile trainer for the 'gbm' market model family.
#
# This is a deliberately dumb batch process: matrices in, trees out. It
# NEVER touches the database and NEVER builds features — the Node side
# (lib/services/market/models/gbmModel.js) produces the numeric matrix from
# the single feature definition in lib/services/scoring/hedonicFeatures.js,
# so feature parity between training and scoring is structural.
#
# Input (JSON file, path via --input):
#   featureNames: [str], X: [[float|null]], y: [float],
#   paramsFold: [int], calibFold: [int],
#   quantiles: {lo, mid, hi}, seed: int
# Output (JSON file, path via --output):
#   ok, params (chosen grid point), bestIterations,
#   boosters (dump_model JSON per quantile), oof (per-row out-of-fold
#   loLog/midLog/hiLog aligned with the input rows), featureImportance
#
# Selection protocol mirrors the ridge model: the hyper-parameter grid
# (num_leaves x min_data_in_leaf) is scored by pinball
# loss on the 'paramsFold' spatially-blocked folds; out-of-fold predictions
# for conformal calibration come from the independently salted 'calibFold'
# folds with the chosen, then FROZEN, parameters and iteration counts, so
# calibration never sees folds tuned on themselves.
#
# Monotone constraints are not used: LightGBM rejects them for the quantile
# objective ("Cannot use monotone_constraints in quantile objective").

import argparse
import json
import sys

import numpy as np
import lightgbm as lgb

LEARNING_RATE = 0.05
MAX_ROUNDS = 800
EARLY_STOPPING_ROUNDS = 50
NUM_LEAVES_GRID = [7, 15, 31]
MIN_DATA_IN_LEAF_GRID = [10, 25, 50]


def base_params(alpha, seed):
    return {
        "objective": "quantile",
        "alpha": alpha,
        "learning_rate": LEARNING_RATE,
        "verbose": -1,
        "seed": seed,
        "deterministic": True,
        "force_row_wise": True,
        "feature_fraction": 0.9,
        "bagging_fraction": 0.9,
        "bagging_freq": 1,
    }


def fold_splits(fold_ids):
    splits = []
    for fold in sorted(set(fold_ids)):
        test_idx = np.where(fold_ids == fold)[0]
        train_idx = np.where(fold_ids != fold)[0]
        if len(test_idx) and len(train_idx):
            splits.append((train_idx, test_idx))
    return splits


def pinball(y_true, y_pred, alpha):
    diff = y_true - y_pred
    return float(np.mean(np.maximum(alpha * diff, (alpha - 1) * diff)))


def cv_best_iteration(X, y, splits, params, feature_names, max_rounds):
    """Manual CV with early stopping on the pooled fold loss; returns
    (best_iteration, best_pooled_pinball)."""
    boosters = []
    for train_idx, test_idx in splits:
        ds = lgb.Dataset(
            X[train_idx],
            label=y[train_idx],
            feature_name=feature_names,
            params={"verbose": -1},
        )
        boosters.append((lgb.train(params, ds, num_boost_round=max_rounds), test_idx))
    best_loss, best_iter = float("inf"), 1
    since_best = 0
    for iteration in range(10, max_rounds + 1, 10):
        preds = np.full(len(y), np.nan)
        for booster, test_idx in boosters:
            preds[test_idx] = booster.predict(X[test_idx], num_iteration=iteration)
        mask = ~np.isnan(preds)
        loss = pinball(y[mask], preds[mask], params["alpha"])
        if loss < best_loss - 1e-9:
            best_loss, best_iter, since_best = loss, iteration, 0
        else:
            since_best += 10
            if since_best >= EARLY_STOPPING_ROUNDS:
                break
    return best_iter, best_loss


def oof_predictions(X, y, splits, params, num_rounds, feature_names):
    preds = np.full(len(y), np.nan)
    for train_idx, test_idx in splits:
        ds = lgb.Dataset(
            X[train_idx],
            label=y[train_idx],
            feature_name=feature_names,
            params={"verbose": -1},
        )
        booster = lgb.train(params, ds, num_boost_round=num_rounds)
        preds[test_idx] = booster.predict(X[test_idx])
    return preds


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    with open(args.input) as f:
        payload = json.load(f)

    feature_names = payload["featureNames"]
    X = np.array(
        [[np.nan if v is None else float(v) for v in row] for row in payload["X"]],
        dtype=np.float64,
    )
    y = np.array(payload["y"], dtype=np.float64)
    params_fold = np.array(payload["paramsFold"], dtype=np.int64)
    calib_fold = np.array(payload["calibFold"], dtype=np.int64)
    quantiles = payload["quantiles"]
    seed = int(payload.get("seed", 7))

    params_splits = fold_splits(params_fold)
    calib_splits = fold_splits(calib_fold)
    if not params_splits or not calib_splits:
        raise ValueError("not enough rows per fold to cross-validate")

    # 1. Grid search on the median model.
    # Every observation counts the same, so there are no weights to pass.
    best = None
    for num_leaves in NUM_LEAVES_GRID:
        for min_data in MIN_DATA_IN_LEAF_GRID:
            params = dict(
                base_params(quantiles["mid"], seed),
                num_leaves=num_leaves,
                min_data_in_leaf=min_data,
            )
            iteration, loss = cv_best_iteration(
                X, y, params_splits, params, feature_names, MAX_ROUNDS
            )
            if best is None or loss < best["loss"] - 1e-9:
                best = {
                    "loss": loss,
                    "num_leaves": num_leaves,
                    "min_data_in_leaf": min_data,
                    "mid_iterations": iteration,
                }

    # 2. Freeze structure params; pick each quantile's iteration count.
    best_iterations = {}
    for name, alpha in quantiles.items():
        params = dict(
            base_params(alpha, seed),
            num_leaves=best["num_leaves"],
            min_data_in_leaf=best["min_data_in_leaf"],
        )
        if name == "mid":
            best_iterations[name] = best["mid_iterations"]
        else:
            best_iterations[name], _ = cv_best_iteration(
                X, y, params_splits, params, feature_names, MAX_ROUNDS
            )

    # 3. Out-of-fold predictions on the calibration folds (frozen params).
    oof = {}
    for name, alpha in quantiles.items():
        params = dict(
            base_params(alpha, seed),
            num_leaves=best["num_leaves"],
            min_data_in_leaf=best["min_data_in_leaf"],
        )
        oof[name + "Log"] = [
            None if np.isnan(v) else float(v)
            for v in oof_predictions(X, y, calib_splits, params, best_iterations[name], feature_names)
        ]

    # 4. Final models on all rows.
    boosters = {}
    importance = {}
    for name, alpha in quantiles.items():
        params = dict(
            base_params(alpha, seed),
            num_leaves=best["num_leaves"],
            min_data_in_leaf=best["min_data_in_leaf"],
        )
        ds = lgb.Dataset(X, label=y, feature_name=feature_names, params={"verbose": -1})
        booster = lgb.train(params, ds, num_boost_round=best_iterations[name])
        boosters[name] = booster.dump_model()
        if name == "mid":
            importance = dict(
                zip(feature_names, [float(v) for v in booster.feature_importance(importance_type="gain")])
            )

    result = {
        "ok": True,
        "params": {
            "num_leaves": best["num_leaves"],
            "min_data_in_leaf": best["min_data_in_leaf"],
            "learning_rate": LEARNING_RATE,
            "cv_pinball_mid": best["loss"],
        },
        "bestIterations": best_iterations,
        "boosters": boosters,
        "oof": oof,
        "featureImportance": importance,
    }
    with open(args.output, "w") as f:
        json.dump(result, f)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - report everything to Node
        try:
            # Best effort: write the failure to --output so Node gets a reason.
            for i, token in enumerate(sys.argv):
                if token == "--output" and i + 1 < len(sys.argv):
                    with open(sys.argv[i + 1], "w") as f:
                        json.dump({"ok": False, "error": f"{type(error).__name__}: {error}"}, f)
                    break
        finally:
            print(f"train_gbm failed: {type(error).__name__}: {error}", file=sys.stderr)
            sys.exit(1)
