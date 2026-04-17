-- Migration 0027: Workflow Registry
-- Adds tables for workflow templates, instances, and step tracking.

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  version INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'draft')),
  tags TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  agent_id TEXT,
  account_id TEXT NOT NULL,
  UNIQUE(name, account_id)
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  agent_role TEXT,
  action_type TEXT,
  description TEXT,
  required INTEGER DEFAULT 1,
  UNIQUE(workflow_id, step_order)
);

CREATE TABLE IF NOT EXISTS workflow_instances (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  current_step INTEGER DEFAULT 1,
  agent_id TEXT,
  context TEXT DEFAULT '{}',
  inputs TEXT DEFAULT '{}',
  outcome TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_step_results (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  agent_id TEXT,
  status TEXT CHECK (status IN ('completed', 'failed', 'skipped')),
  outcome TEXT,
  duration_ms INTEGER,
  token_count INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_workflow ON workflow_instances(workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_agent ON workflow_instances(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_step_results_instance ON workflow_step_results(instance_id, step_order);
