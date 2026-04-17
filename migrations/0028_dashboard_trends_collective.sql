-- Migration 0028: Dashboard, Trends, Collective Patterns, Impact Tracking
-- Part of Marrow Backend V4 spec

-- Feature 3: Daily stats for trend tracking
CREATE TABLE IF NOT EXISTS daily_stats (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  total_decisions INTEGER DEFAULT 0,
  successful_decisions INTEGER DEFAULT 0,
  failed_decisions INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 0,
  by_type TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(account_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_stats_account_date ON daily_stats(account_id, date DESC);

-- Feature 4: Anonymized cross-account collective patterns
CREATE TABLE IF NOT EXISTS collective_patterns (
  id TEXT PRIMARY KEY,
  pattern_key TEXT NOT NULL UNIQUE,
  decision_type TEXT NOT NULL,
  action_cluster TEXT NOT NULL,
  total_decisions INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 0,
  top_failure_reasons TEXT DEFAULT '[]',
  top_success_patterns TEXT DEFAULT '[]',
  sample_size INTEGER DEFAULT 0,
  account_count INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_collective_patterns_type ON collective_patterns(decision_type, success_rate);

-- Feature 5: Auto-detected workflows from recurring patterns
CREATE TABLE IF NOT EXISTS detected_workflows (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  pattern_hash TEXT NOT NULL,
  step_sequence TEXT NOT NULL,
  occurrence_count INTEGER DEFAULT 0,
  suggested_at TEXT,
  accepted INTEGER DEFAULT 0,
  workflow_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(account_id, pattern_hash)
);

CREATE INDEX IF NOT EXISTS idx_detected_workflows_account ON detected_workflows(account_id, accepted, occurrence_count DESC);

-- Feature 6: Impact tracking - "saves" metric
CREATE TABLE IF NOT EXISTS saves (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  warning_type TEXT NOT NULL,
  warning_message TEXT NOT NULL,
  subsequent_decision_id TEXT,
  subsequent_success INTEGER,
  confirmed_save INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_saves_account ON saves(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saves_decision ON saves(decision_id);

-- Feature 2: Add session tracking columns to decisions table
-- Note: If these columns already exist, these statements will fail harmlessly
ALTER TABLE decisions ADD COLUMN session_id TEXT;
ALTER TABLE decisions ADD COLUMN auto_committed INTEGER DEFAULT 0;

-- Feature 4: Add collective_opt_out column to accounts for privacy
ALTER TABLE accounts ADD COLUMN collective_opt_out INTEGER DEFAULT 0;

-- Indexes for session-based queries
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_auto_committed ON decisions(account_id, auto_committed, created_at);