-- 0013: 3-Tier Architecture (Free/Pro/Enterprise)
-- Adds: tiers config, orgs, org_members, webhooks, context_hive, team visibility

-- Tier configuration table
CREATE TABLE IF NOT EXISTS tiers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  retention_days INTEGER NOT NULL,
  pii_strip INTEGER NOT NULL DEFAULT 0,
  team_mode INTEGER NOT NULL DEFAULT 0,
  webhooks INTEGER NOT NULL DEFAULT 0,
  analytics INTEGER NOT NULL DEFAULT 0,
  export INTEGER NOT NULL DEFAULT 0,
  semantic_search INTEGER NOT NULL DEFAULT 0
);

-- Seed tier config
INSERT OR IGNORE INTO tiers (id, name, retention_days, pii_strip, team_mode, webhooks, analytics, export, semantic_search)
VALUES
  ('tier_free', 'free', 30, 0, 0, 0, 0, 0, 0),
  ('tier_pro', 'pro', 365, 1, 0, 1, 1, 1, 1),
  ('tier_enterprise', 'enterprise', -1, 1, 1, 1, 1, 1, 1);

-- Orgs (Enterprise)
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_account_id) REFERENCES accounts(id)
);

-- Org members
CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL,
  PRIMARY KEY (org_id, account_id),
  FOREIGN KEY (org_id) REFERENCES orgs(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  CHECK (role IN ('owner', 'admin', 'member'))
);

-- Webhooks (Pro/Enterprise)
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  decision_types TEXT, -- JSON array or null for all
  active INTEGER NOT NULL DEFAULT 1,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Add org_id to accounts
ALTER TABLE accounts ADD COLUMN org_id TEXT REFERENCES orgs(id);

-- Add context_hive (PII-stripped) to decisions
ALTER TABLE decisions ADD COLUMN context_hive TEXT;

-- Update visibility CHECK to include 'team'
-- SQLite doesn't support ALTER CHECK, so we handle this in application code

-- Indexes
CREATE INDEX IF NOT EXISTS idx_org_members_account ON org_members(account_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_account ON webhooks(account_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(active);
CREATE INDEX IF NOT EXISTS idx_decisions_context_hive ON decisions(context_hive);
CREATE INDEX IF NOT EXISTS idx_accounts_org_id ON accounts(org_id);
