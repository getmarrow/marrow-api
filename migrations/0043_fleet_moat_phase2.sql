-- Migration 0043: Fleet Moat Phase 2
-- Adds ranked fleet lessons, persisted risk gates, deployment memory, handoffs,
-- and per-agent memory permission metadata.

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
  last_reused_at TEXT,
  CHECK (lesson_type IN ('success', 'failure', 'deploy', 'incident', 'handoff', 'general')),
  CHECK (visibility IN ('private', 'shared', 'production-critical'))
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
  created_at TEXT NOT NULL,
  CHECK (risk_level IN ('low', 'medium', 'high')),
  CHECK (decision IN ('allow', 'warn', 'review_required', 'block'))
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
  updated_at TEXT NOT NULL,
  CHECK (status IN ('planned', 'dry_run', 'deployed', 'verified', 'rolled_back', 'incident'))
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
  completed_at TEXT,
  CHECK (status IN ('pending', 'accepted', 'working', 'blocked', 'complete', 'stale', 'cancelled'))
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
  UNIQUE(account_id, agent_id, scope, resource_type, resource_id),
  CHECK (permission IN ('read-only', 'contribute-only', 'private', 'shared', 'production-critical'))
);

CREATE INDEX IF NOT EXISTS idx_fleet_memory_permissions_account ON fleet_memory_permissions(account_id, agent_id);
