-- Tier 1: Authentication
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL,
  CHECK (tier IN ('free', 'pro', 'enterprise'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  CHECK (status IN ('active', 'revoked'))
);

-- Tier 2-3: Decisions & Outcomes
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  context TEXT NOT NULL,
  outcome TEXT NOT NULL,
  confidence REAL NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  context_compressed INTEGER DEFAULT 0,
  context_raw TEXT,
  impact_score REAL DEFAULT 0.0,
  reuse_count INTEGER DEFAULT 0,
  last_reused_at TEXT,
  outcome_recorded_at TEXT,
  outcome_success INTEGER,
  outcome_details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  CHECK (confidence >= 0.0 AND confidence <= 1.0),
  CHECK (visibility IN ('private', 'shared', 'hive'))
);

-- Tier 4: Collaboration
CREATE TABLE IF NOT EXISTS decision_shares (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  shared_by_account_id TEXT NOT NULL,
  shared_with_account_id TEXT NOT NULL,
  trust_score REAL NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES decisions(id),
  FOREIGN KEY (shared_by_account_id) REFERENCES accounts(id),
  FOREIGN KEY (shared_with_account_id) REFERENCES accounts(id),
  CHECK (trust_score >= 0.0 AND trust_score <= 1.0)
);

-- Tier 6: Causal Reasoning
CREATE TABLE IF NOT EXISTS causality_edges (
  id TEXT PRIMARY KEY,
  from_decision_id TEXT NOT NULL,
  to_decision_id TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (from_decision_id) REFERENCES decisions(id),
  FOREIGN KEY (to_decision_id) REFERENCES decisions(id),
  UNIQUE (from_decision_id, to_decision_id)
);

-- Tier 7: Predictive Routing
CREATE TABLE IF NOT EXISTS decision_vectors (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  vector_embedding TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES decisions(id),
  UNIQUE (decision_id)
);

-- Tier 8: Pattern Discovery
CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  pattern_signature TEXT NOT NULL,
  frequency INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  UNIQUE (account_id, pattern_signature)
);

CREATE TABLE IF NOT EXISTS trend_signals (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  trend_direction TEXT NOT NULL,
  magnitude REAL NOT NULL,
  calculated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  CHECK (trend_direction IN ('up', 'down', 'stable')),
  UNIQUE (account_id, decision_type, calculated_at)
);

-- Tier 9: Transfer Learning
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  domain_tags TEXT,
  transferability_score REAL DEFAULT 0.5,
  is_published INTEGER DEFAULT 0,
  publisher_reputation REAL DEFAULT 0.0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Tier 10: Priority Queue
CREATE TABLE IF NOT EXISTS priority_queue (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  priority_score REAL NOT NULL,
  recalculated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (decision_id) REFERENCES decisions(id),
  UNIQUE (decision_id)
);

-- Tier 13: Audit & Compliance
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  account_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  changes TEXT,
  hash TEXT NOT NULL UNIQUE,
  prev_hash TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Tier 14: Hive Consensus
CREATE TABLE IF NOT EXISTS consensus_votes (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  voting_agent_id TEXT NOT NULL,
  agrees INTEGER NOT NULL,
  confidence_boost REAL DEFAULT 1.0,
  voted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES decisions(id),
  UNIQUE (decision_id, voting_agent_id),
  CHECK (agrees IN (0, 1))
);

-- Tier 15: Snapshots
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  snapshot_time TEXT NOT NULL,
  decisions_count INTEGER NOT NULL,
  lessons_count INTEGER NOT NULL,
  file_size INTEGER NOT NULL,
  data_encrypted TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Tier 16: API Versioning
CREATE TABLE IF NOT EXISTS api_versions (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  released_at TEXT NOT NULL,
  deprecated_at TEXT,
  breaking_changes TEXT,
  created_at TEXT NOT NULL
);

-- Tier 17: Analytics
CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  metric_name TEXT NOT NULL,
  value REAL NOT NULL,
  recorded_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Tier 18: Marketplace
CREATE TABLE IF NOT EXISTS lesson_stats (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  view_count INTEGER DEFAULT 0,
  fork_count INTEGER DEFAULT 0,
  rating_avg REAL DEFAULT 0.0,
  reputation_score REAL DEFAULT 0.0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (lesson_id) REFERENCES lessons(id),
  UNIQUE (lesson_id)
);

-- Tier 19: Safety & Alignment
CREATE TABLE IF NOT EXISTS safety_violations (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  violation_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  action_taken TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES decisions(id),
  CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  CHECK (action_taken IN ('warn', 'block', 'escalate'))
);

-- Tier 12: Bootstrap Templates
CREATE TABLE IF NOT EXISTS bootstrap_templates (
  decision_type TEXT PRIMARY KEY,
  template_decisions TEXT NOT NULL,
  success_rate REAL DEFAULT 0.5,
  created_at TEXT NOT NULL
);

-- Tier 20: Streaming (no dedicated table, uses existing)

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_decisions_account_id ON decisions(account_id);
CREATE INDEX IF NOT EXISTS idx_decisions_decision_type ON decisions(decision_type);
CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_visibility ON decisions(visibility);
CREATE INDEX IF NOT EXISTS idx_audit_log_account_id ON audit_log(account_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_account_id ON api_keys(account_id);
CREATE INDEX IF NOT EXISTS idx_lessons_account_id ON lessons(account_id);
CREATE INDEX IF NOT EXISTS idx_lessons_is_published ON lessons(is_published);
CREATE INDEX IF NOT EXISTS idx_patterns_account_id ON patterns(account_id);
CREATE INDEX IF NOT EXISTS idx_patterns_decision_type ON patterns(decision_type);
CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_metric_name ON analytics_snapshots(metric_name);
CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_recorded_at ON analytics_snapshots(recorded_at);
