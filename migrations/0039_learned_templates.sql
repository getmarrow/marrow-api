-- Migration 0039: Learned Templates table
-- Stores templates extracted from pattern clusters for on-demand browsing.
-- Lightweight: no FK constraints, safe to drop/recreate on rerun.
-- Rerunnable: DROP IF EXISTS + CREATE IF NOT EXISTS.

DROP TABLE IF EXISTS learned_templates;

CREATE TABLE IF NOT EXISTS learned_templates (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL UNIQUE,
  pattern_cluster TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]',
  success_rate REAL NOT NULL DEFAULT 0.0,
  confidence REAL NOT NULL DEFAULT 0.0,
  usage_count INTEGER NOT NULL DEFAULT 0,
  decision_type TEXT NOT NULL DEFAULT 'general',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_learned_templates_score ON learned_templates(confidence * success_rate DESC);
