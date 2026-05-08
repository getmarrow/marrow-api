-- Tier 1: Authentication
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'free',
  nudged_at TEXT DEFAULT NULL,
  nudged_decision_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK (tier IN ('free', 'pro', 'enterprise', 'owner'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  name TEXT,
  key_type TEXT NOT NULL DEFAULT 'live',
  prefix TEXT,
  scopes TEXT NOT NULL DEFAULT '["full"]',
  last_used_ip TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_by TEXT,
  agent_ids TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  CHECK (status IN ('active', 'revoked')),
  CHECK (key_type IN ('live', 'test'))
);

CREATE TABLE IF NOT EXISTS api_key_audit_log (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  key_id TEXT,
  event TEXT NOT NULL,
  actor TEXT,
  ip TEXT,
  user_agent TEXT,
  details TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (key_id) REFERENCES api_keys(id),
  CHECK (event IN ('created', 'revoked', 'rotated', 'auth_failed', 'auth_success'))
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
  quality TEXT,
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
  model TEXT NOT NULL DEFAULT 'bge-base-en-v1.5',
  dimensions INTEGER NOT NULL DEFAULT 768,
  created_at TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES decisions(id),
  UNIQUE (decision_id)
);

CREATE INDEX IF NOT EXISTS idx_decision_vectors_type ON decision_vectors(decision_type);

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


-- Persistent Memory
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) < 128),
  account_id TEXT NOT NULL CHECK (length(account_id) > 0 AND length(account_id) < 200),
  text TEXT NOT NULL CHECK (length(text) > 0 AND length(text) < 50000),
  source TEXT,
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'outdated', 'superseded', 'deleted')),
  supersedes TEXT REFERENCES memories(id),
  superseded_by TEXT REFERENCES memories(id),
  deleted_at TEXT,
  audit TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(audit) AND json_type(audit) = 'array'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS memory_shares (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (memory_id) REFERENCES memories(id),
  UNIQUE (memory_id, account_id, agent_id)
);

CREATE TRIGGER IF NOT EXISTS memory_shares_account_match_insert
BEFORE INSERT ON memory_shares
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM memories WHERE id = NEW.memory_id AND account_id = NEW.account_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory_shares account mismatch');
END;

CREATE TRIGGER IF NOT EXISTS memory_shares_account_match_update
BEFORE UPDATE OF memory_id, account_id ON memory_shares
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM memories WHERE id = NEW.memory_id AND account_id = NEW.account_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory_shares account mismatch');
END;

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


CREATE TABLE IF NOT EXISTS workflow_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  description TEXT,
  industry TEXT,
  category TEXT,
  author TEXT DEFAULT 'marrow',
  steps TEXT NOT NULL,
  install_count INTEGER DEFAULT 0,
  avg_success_rate REAL,
  tags TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_templates_industry ON workflow_templates(industry, install_count DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_slug ON workflow_templates(slug);

-- Learned Templates (Phase 2)
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

CREATE INDEX IF NOT EXISTS idx_learned_templates_score ON learned_templates(confidence * success_rate);

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
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_status_account ON api_keys(account_id, status);
CREATE INDEX IF NOT EXISTS idx_api_key_audit_account ON api_key_audit_log(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_key_audit_key ON api_key_audit_log(key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lessons_account_id ON lessons(account_id);
CREATE INDEX IF NOT EXISTS idx_lessons_is_published ON lessons(is_published);
CREATE INDEX IF NOT EXISTS idx_memories_account_status ON memories(account_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_account_updated_at ON memories(account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_account_created ON memories(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
CREATE INDEX IF NOT EXISTS idx_memory_shares_account_agent ON memory_shares(account_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_shares_memory_id ON memory_shares(memory_id);
CREATE INDEX IF NOT EXISTS idx_patterns_account_id ON patterns(account_id);
CREATE INDEX IF NOT EXISTS idx_patterns_decision_type ON patterns(decision_type);
CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_metric_name ON analytics_snapshots(metric_name);
CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_recorded_at ON analytics_snapshots(recorded_at);

-- Fleet moat phase 2: ranked lessons, gates, deploy memories, handoffs, permissions
CREATE TABLE IF NOT EXISTS fleet_lessons (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source_decision_id TEXT,
  agent_id TEXT,
  lesson_type TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  action_pattern TEXT,
  outcome_success INTEGER,
  confidence REAL NOT NULL DEFAULT 0.5,
  score REAL NOT NULL DEFAULT 0.5,
  reuse_count INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'shared',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_reused_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_fleet_lessons_account_score ON fleet_lessons(account_id, score DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_lessons_agent ON fleet_lessons(account_id, agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_lessons_source_decision ON fleet_lessons(account_id, source_decision_id);

CREATE TABLE IF NOT EXISTS risk_gate_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT,
  action TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  decision TEXT NOT NULL,
  allow INTEGER NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  policy TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_risk_gate_events_account ON risk_gate_events(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_gate_events_agent ON risk_gate_events(account_id, agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deployment_memories (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  agent_id TEXT,
  workflow_id TEXT,
  release_id TEXT,
  pr_url TEXT,
  commit_sha TEXT,
  environment TEXT NOT NULL DEFAULT 'production',
  status TEXT NOT NULL DEFAULT 'planned',
  tests TEXT NOT NULL DEFAULT '[]',
  smoke_result TEXT,
  rollback_plan TEXT,
  prod_health TEXT,
  incident_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deployment_memories_account ON deployment_memories(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployment_memories_release ON deployment_memories(account_id, release_id);

CREATE TABLE IF NOT EXISTS agent_handoffs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  workflow_id TEXT,
  from_agent_id TEXT,
  to_agent_id TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  checkpoint TEXT,
  result_summary TEXT,
  stale_after_seconds INTEGER NOT NULL DEFAULT 1800,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_handoffs_account_status ON agent_handoffs(account_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_to_agent ON agent_handoffs(account_id, to_agent_id, status);

CREATE TABLE IF NOT EXISTS fleet_memory_permissions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'fleet',
  permission TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT 'memory',
  resource_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, agent_id, scope, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_fleet_memory_permissions_account ON fleet_memory_permissions(account_id, agent_id);
