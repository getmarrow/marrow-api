-- Migration 0029: Fleet Primitives (V5 Phase 1)
-- Adds: agents registry, organization enhancements, workflow templates marketplace, fleet dashboard support

-- ============= 1. Agents Registry =============

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  specialty TEXT,
  avatar_url TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  api_key_hash TEXT UNIQUE,
  total_decisions INTEGER DEFAULT 0,
  success_rate REAL,
  last_active_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_agents_account ON agents(account_id, status);
CREATE INDEX IF NOT EXISTS idx_agents_last_active ON agents(last_active_at DESC);

-- Add agent_id to decisions (nullable; backward compat — falls back to session_id)
ALTER TABLE decisions ADD COLUMN agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decisions(agent_id, created_at DESC);

-- ============= 2. Organization Enhancements =============
-- orgs + org_members already exist from 0013. Add missing columns.

-- Add slug, industry, plan to orgs
ALTER TABLE orgs ADD COLUMN slug TEXT;
ALTER TABLE orgs ADD COLUMN industry TEXT;
ALTER TABLE orgs ADD COLUMN plan TEXT DEFAULT 'free';
ALTER TABLE orgs ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_slug ON orgs(slug);

-- Add id, invited_at columns to org_members (existing PK is composite org_id+account_id)
-- SQLite can't ALTER composite PK, so we add id as a regular unique column
ALTER TABLE org_members ADD COLUMN id TEXT;
ALTER TABLE org_members ADD COLUMN invited_at TEXT DEFAULT (datetime('now'));

-- Update role CHECK to include operator and viewer
-- SQLite can't ALTER CHECK constraints — enforce in application code

-- ============= 3. Workflow Templates Marketplace =============

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

-- ============= 4. Seed 10 Workflow Templates =============

INSERT OR IGNORE INTO workflow_templates (id, name, slug, description, industry, category, author, steps, tags) VALUES
('tpl-code-review-deploy', 'Code Review & Deploy', 'code-review-deploy',
 'Standard engineering workflow: build, review, merge, deploy, verify.',
 'saas', 'engineering', 'marrow',
 '[{"step":1,"name":"Build","description":"Implement the feature or fix","agent_role":"builder"},{"step":2,"name":"Review","description":"Code review and audit","agent_role":"reviewer"},{"step":3,"name":"Merge","description":"Merge to main branch","agent_role":"builder"},{"step":4,"name":"Deploy","description":"Deploy to production","agent_role":"deployer"},{"step":5,"name":"Verify","description":"Post-deploy verification","agent_role":"monitor"}]',
 '["engineering","ci-cd","deploy"]');

INSERT OR IGNORE INTO workflow_templates (id, name, slug, description, industry, category, author, steps, tags) VALUES
('tpl-incident-response', 'Incident Response', 'incident-response',
 'Detect, triage, fix, verify, and document incidents.',
 'saas', 'engineering', 'marrow',
 '[{"step":1,"name":"Detect","description":"Identify the incident","agent_role":"monitor"},{"step":2,"name":"Triage","description":"Assess severity and impact","agent_role":"ops"},{"step":3,"name":"Fix","description":"Implement the fix","agent_role":"builder"},{"step":4,"name":"Verify","description":"Confirm resolution","agent_role":"monitor"},{"step":5,"name":"Postmortem","description":"Document lessons learned","agent_role":"ops"}]',
 '["engineering","incident","ops"]');

INSERT OR IGNORE INTO workflow_templates (id, name, slug, description, industry, category, author, steps, tags) VALUES
('tpl-feature-rollout', 'Feature Rollout', 'feature-rollout',
 'Build, audit, stage, roll out, and monitor new features.',
 'saas', 'engineering', 'marrow',
 '[{"step":1,"name":"Build","description":"Implement the feature","agent_role":"builder"},{"step":2,"name":"Audit","description":"Security and quality audit","agent_role":"auditor"},{"step":3,"name":"Staging","description":"Deploy to staging environment","agent_role":"deployer"},{"step":4,"name":"Rollout","description":"Gradual production rollout","agent_role":"deployer"},{"step":5,"name":"Monitor","description":"Monitor metrics and alerts","agent_role":"monitor"}]',
 '["engineering","rollout","feature"]');

INSERT OR IGNORE INTO workflow_templates (id, name, slug, description, industry, category, author, steps, tags) VALUES
('tpl-ticket-triage', 'Ticket Triage', 'ticket-triage',
 'Classify, route, respond, follow up, and close support tickets.',
 'saas', 'support', 'marrow',
 '[{"step":1,"name":"Classify","description":"Categorize the incoming ticket","agent_role":"classifier"},{"step":2,"name":"Route","description":"Route to appropriate team","agent_role":"router"},{"step":3,"name":"Respond","description":"Send initial response","agent_role":"responder"},{"step":4,"name":"Follow-up","description":"Check resolution status","agent_role":"responder"},{"step":5,"name":"Close","description":"Close the ticket","agent_role":"closer"}]',
 '["support","tickets","triage"]');

INSERT OR IGNORE INTO workflow_templates (id, name, slug, description, industry, category, author, steps, tags) VALUES
('tpl-escalation-flow', 'Escalation Flow', 'escalation-flow',
 'Acknowledge, investigate, escalate, resolve, and notify.',
 'saas', 'support', 'marrow',
 '[{"step":1,"name":"Acknowledge","description":"Acknowledge the issue","agent_role":"responder"},{"step":2,"name":"Investigate","description":"Root cause investigation","agent_role":"investigator"},{"step":3,"name":"Escalate","description":"Escalate to senior team","agent_role":"escalator"},{"step":4,"name":"Resolve","description":"Implement resolution","agent_role":"resolver"},{"step":5,"name":"Notify","description":"Notify stakeholders","agent_role":"notifier"}]',
 '["support","escalation","ops"]');

INSERT OR IGNORE INTO workflow_templates (id, name, slug, description, industry, category, author, steps, tags) VALUES
('tpl-lead-qualify', 'Lead Qualification', 'lead-qualify',
 'Inbound lead through research, qualification, engagement, demo, and proposal.',
 'saas', 'sales', 'marrow',
 '[{"step":1,"name":"Inbound","description":"Receive and log inbound lead","agent_role":"intake"},{"step":2,"name":"Research","description":"Research company and contacts","agent_role":"researcher"},{"step":3,"name":"Qualify","description":"Score and qualify the lead","agent_role":"qualifier"},{"step":4,"name":"Engage","description":"Initial outreach","agent_role":"sdr"},{"step":5,"name":"Demo","description":"Schedule and run demo","agent_role":"ae"},{"step":6,"name":"Proposal","description":"Send proposal","agent_role":"ae"}]',
 '["sales","leads","pipeline"]');

INSERT OR IGNORE INTO workflow_templates (id, name, slug, description, industry, category, author, steps, tags) VALUES
('tpl-content-publish', 'Content Publish', 'content-publish',
 'Draft, edit, approve, publish, and measure content.',
 'media', 'content', 'marrow',
 '[{"step":1,"name":"Draft","description":"Write initial draft","agent_role":"writer"},{"step":2,"name":"Edit","description":"Edit and refine","agent_role":"editor"},{"step":3,"name":"Approve","description":"Final approval","agent_role":"approver"},{"step":4,"name":"Publish","description":"Publish content","agent_role":"publisher"},{"step":5,"name":"Measure","description":"Track performance metrics","agent_role":"analyst"}]',
 '["content","publishing","marketing"]');

INSERT OR IGNORE INTO workflow_templates (id, name, slug, description, industry, category, author, steps, tags) VALUES
('tpl-etl-pipeline', 'ETL Pipeline', 'etl-pipeline',
 'Extract, validate, transform, load, and report on data.',
 'fintech', 'data', 'marrow',
 '[{"step":1,"name":"Extract","description":"Extract data from sources","agent_role":"extractor"},{"step":2,"name":"Validate","description":"Validate data quality","agent_role":"validator"},{"step":3,"name":"Transform","description":"Transform and normalize","agent_role":"transformer"},{"step":4,"name":"Load","description":"Load into target systems","agent_role":"loader"},{"step":5,"name":"Report","description":"Generate completion report","agent_role":"reporter"}]',
 '["data","etl","pipeline"]');

INSERT OR IGNORE INTO workflow_templates (id, name, slug, description, industry, category, author, steps, tags) VALUES
('tpl-approval-flow', 'Approval Flow', 'approval-flow',
 'Request, review, approve, process, and reconcile.',
 'fintech', 'finance', 'marrow',
 '[{"step":1,"name":"Request","description":"Submit request for approval","agent_role":"requester"},{"step":2,"name":"Review","description":"Review request details","agent_role":"reviewer"},{"step":3,"name":"Approve","description":"Approve or reject","agent_role":"approver"},{"step":4,"name":"Process","description":"Execute the approved action","agent_role":"processor"},{"step":5,"name":"Reconcile","description":"Verify and reconcile","agent_role":"reconciler"}]',
 '["finance","approval","compliance"]');

INSERT OR IGNORE INTO workflow_templates (id, name, slug, description, industry, category, author, steps, tags) VALUES
('tpl-change-management', 'Change Management', 'change-management',
 'Propose, review, schedule, execute, and verify changes.',
 'enterprise', 'ops', 'marrow',
 '[{"step":1,"name":"Propose","description":"Submit change proposal","agent_role":"proposer"},{"step":2,"name":"Review","description":"Peer review the change","agent_role":"reviewer"},{"step":3,"name":"Schedule","description":"Schedule change window","agent_role":"scheduler"},{"step":4,"name":"Execute","description":"Execute the change","agent_role":"executor"},{"step":5,"name":"Verify","description":"Verify change succeeded","agent_role":"verifier"}]',
 '["ops","change-management","itil"]');
