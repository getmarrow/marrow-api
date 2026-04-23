-- Migration: baseline_snapshots
-- Stores day-1 baseline snapshots for accounts and agents to enable
-- "improvement since onboarding" pitch metric on the dashboard.

CREATE TABLE IF NOT EXISTS account_baselines (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  captured_at TEXT NOT NULL,
  first_decision_at TEXT NOT NULL,
  days_in_window INTEGER NOT NULL,
  decisions_in_window INTEGER NOT NULL,
  attempts_per_success REAL,
  time_to_success_seconds REAL,
  drift_rate REAL,
  success_rate REAL,
  trigger_reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_baselines_account ON account_baselines(account_id);

CREATE TABLE IF NOT EXISTS agent_baselines (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  first_decision_at TEXT NOT NULL,
  days_in_window INTEGER NOT NULL,
  decisions_in_window INTEGER NOT NULL,
  attempts_per_success REAL,
  time_to_success_seconds REAL,
  drift_rate REAL,
  success_rate REAL,
  trigger_reason TEXT NOT NULL,
  UNIQUE(account_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_baselines_account_agent ON agent_baselines(account_id, agent_id);