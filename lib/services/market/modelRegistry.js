/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

// An artifact answers for one family in one market. Both are part of its
// identity, so a Munich retrain cannot land on Berlin's model.
export function saveModel(db, { family, market, runId, version, createdAt, trainingRows, artifact, evaluation }) {
  db.prepare(
    `INSERT INTO homeserver_models
       (family, market, run_id, model_version, created_at, training_rows, artifact_json, eval_json)
     VALUES (@family, @market, @runId, @version, @createdAt, @trainingRows, @artifactJson, @evalJson)
     ON CONFLICT(family, market) DO UPDATE SET
       run_id = excluded.run_id, model_version = excluded.model_version,
       created_at = excluded.created_at, training_rows = excluded.training_rows,
       artifact_json = excluded.artifact_json, eval_json = excluded.eval_json`,
  ).run({
    family,
    market,
    runId,
    version,
    createdAt,
    trainingRows,
    artifactJson: JSON.stringify(artifact),
    evalJson: JSON.stringify(evaluation),
  });
}

export function loadModel(db, family, market) {
  const row = db
    .prepare(
      `SELECT family, market, run_id, model_version, created_at, training_rows, artifact_json, eval_json
       FROM homeserver_models WHERE family = ? AND market = ?`,
    )
    .get(family, market);
  if (!row) return null;
  try {
    return {
      family: row.family,
      market: row.market,
      runId: row.run_id,
      version: row.model_version,
      createdAt: row.created_at,
      trainingRows: row.training_rows,
      artifact: JSON.parse(row.artifact_json),
      evaluation: JSON.parse(row.eval_json),
    };
  } catch {
    return null;
  }
}
