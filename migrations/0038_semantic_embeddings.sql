-- Migration 0038: semantic embeddings for collective intelligence
-- Rebuilds decision_vectors safely and backfills legacy vectors with explicit
-- model/dimension metadata so reruns stay stable.

PRAGMA foreign_keys = OFF;

DROP INDEX IF EXISTS idx_decision_vectors_type;
DROP TABLE IF EXISTS decision_vectors_rebuild;

CREATE TABLE decision_vectors_rebuild (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  vector_embedding TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'bge-base-en-v1.5',
  dimensions INTEGER NOT NULL DEFAULT 768,
  created_at TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES decisions(id),
  UNIQUE (decision_id)
);

INSERT OR IGNORE INTO decision_vectors_rebuild (
  id,
  decision_id,
  vector_embedding,
  decision_type,
  model,
  dimensions,
  created_at
)
SELECT
  id,
  decision_id,
  vector_embedding,
  decision_type,
  CASE
    WHEN COALESCE(json_array_length(vector_embedding), 0) = 768 THEN 'bge-base-en-v1.5'
    ELSE 'token-fallback'
  END,
  COALESCE(json_array_length(vector_embedding), 768),
  created_at
FROM decision_vectors;

DROP TABLE decision_vectors;
ALTER TABLE decision_vectors_rebuild RENAME TO decision_vectors;

CREATE INDEX IF NOT EXISTS idx_decision_vectors_type ON decision_vectors(decision_type);

PRAGMA foreign_keys = ON;
