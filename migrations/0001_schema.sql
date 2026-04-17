-- Marrow API Schema (Minimal Working Version)

-- Accounts
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  tier TEXT DEFAULT 'free',
  created_at TEXT DEFAULT (datetime('now'))
);

-- API Keys
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id);

-- Decisions
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  context TEXT NOT NULL,
  outcome TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  visibility TEXT DEFAULT 'private',
  context_compressed INTEGER DEFAULT 0,
  context_raw TEXT,
  impact_score REAL DEFAULT 0,
  reuse_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_decisions_account ON decisions(account_id);
CREATE INDEX IF NOT EXISTS idx_decisions_type ON decisions(decision_type);

-- Decision Vectors (Tier 7: Predictive Routing)
CREATE TABLE IF NOT EXISTS decision_vectors (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  vector_embedding TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (decision_id) REFERENCES decisions(id)
);
CREATE INDEX IF NOT EXISTS idx_decision_vectors_decision ON decision_vectors(decision_id);
CREATE INDEX IF NOT EXISTS idx_decision_vectors_type ON decision_vectors(decision_type);

-- Hive Signals
CREATE TABLE IF NOT EXISTS hive_signals (
  decision_type TEXT PRIMARY KEY,
  avg_success_rate REAL DEFAULT 0,
  agent_count INTEGER DEFAULT 0,
  last_updated TEXT DEFAULT (datetime('now'))
);

-- Lessons
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  success_rate REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Snapshots
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  snapshot_time TEXT NOT NULL,
  decisions_count INTEGER DEFAULT 0,
  lessons_count INTEGER DEFAULT 0,
  data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Bootstrap Templates
CREATE TABLE IF NOT EXISTS bootstrap_templates (
  id TEXT PRIMARY KEY,
  decision_type TEXT NOT NULL,
  template_decisions TEXT NOT NULL,
  success_rate REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Patterns
CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,
  decision_type TEXT NOT NULL,
  pattern_signature TEXT NOT NULL UNIQUE,
  frequency INTEGER DEFAULT 0,
  confidence REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Trend Signals
CREATE TABLE IF NOT EXISTS trends (
  id TEXT PRIMARY KEY,
  decision_type TEXT NOT NULL,
  trend_direction TEXT NOT NULL,
  magnitude REAL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Audit Log
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  changes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Consensus Votes
CREATE TABLE IF NOT EXISTS consensus_votes (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  voting_agent_id TEXT NOT NULL,
  agrees INTEGER DEFAULT 1,
  confidence REAL DEFAULT 0.5,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (decision_id) REFERENCES decisions(id)
);

-- Versions
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  released_at TEXT NOT NULL,
  deprecated_at TEXT,
  changes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Analytics
CREATE TABLE IF NOT EXISTS analytics (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL DEFAULT 0,
  recorded_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Safety Violations
CREATE TABLE IF NOT EXISTS safety_violations (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  violation_type TEXT NOT NULL,
  risk_score REAL DEFAULT 0,
  detected_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (decision_id) REFERENCES decisions(id)
);

-- Marketplace Listings
CREATE TABLE IF NOT EXISTS marketplace (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  rating REAL DEFAULT 0,
  fork_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lesson_id) REFERENCES lessons(id)
);
