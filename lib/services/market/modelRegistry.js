/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Model registry: one persisted artifact per model family, written by the
 * trainer run and read by the notification-time scorer. Families are equals;
 * there is no champion flag — both artifacts score every listing and both
 * scores are rendered. A family that fails to train simply keeps its last
 * artifact serving.
 */

/**
 * Upsert a family's artifact.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} entry
 * @param {string} entry.family
 * @param {string} entry.runId
 * @param {string} entry.version
 * @param {number} entry.createdAt
 * @param {number} entry.trainingRows
 * @param {object} entry.artifact
 * @param {object} entry.evaluation
 */
export function saveModel(db, { family, runId, version, createdAt, trainingRows, artifact, evaluation }) {
  db.prepare(
    `INSERT INTO homeserver_models (family, run_id, model_version, created_at, training_rows, artifact_json, eval_json)
     VALUES (@family, @runId, @version, @createdAt, @trainingRows, @artifactJson, @evalJson)
     ON CONFLICT(family) DO UPDATE SET
       run_id = excluded.run_id, model_version = excluded.model_version,
       created_at = excluded.created_at, training_rows = excluded.training_rows,
       artifact_json = excluded.artifact_json, eval_json = excluded.eval_json`,
  ).run({
    family,
    runId,
    version,
    createdAt,
    trainingRows,
    artifactJson: JSON.stringify(artifact),
    evalJson: JSON.stringify(evaluation),
  });
}

/**
 * Load one family's artifact; null when absent or unparseable.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} family
 * @returns {{family: string, runId: string, version: string, createdAt: number,
 *   trainingRows: number, artifact: object, evaluation: object}|null}
 */
export function loadModel(db, family) {
  const row = db
    .prepare(
      `SELECT family, run_id, model_version, created_at, training_rows, artifact_json, eval_json
       FROM homeserver_models WHERE family = ?`,
    )
    .get(family);
  if (!row) return null;
  try {
    return {
      family: row.family,
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
