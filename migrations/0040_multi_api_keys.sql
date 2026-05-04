-- 0040_multi_api_keys.sql
-- Phase A: multi-API-key enterprise key management

PRAGMA foreign_keys=off;

-- Fix duplicate emails before migration
DELETE FROM accounts WHERE id NOT IN (
  SELECT MIN(id) FROM accounts GROUP BY email
);

CREATE TABLE accounts_v2 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL,
  CHECK (tier IN ('free', 'pro', 'enterprise', 'owner'))
);

INSERT INTO accounts_v2 (id, name, email, tier, created_at)
SELECT id, name, email, tier, created_at
FROM accounts;

DROP TABLE accounts;
ALTER TABLE accounts_v2 RENAME TO accounts;

PRAGMA foreign_keys=on;

ALTER TABLE api_keys ADD COLUMN name TEXT;
ALTER TABLE api_keys ADD COLUMN key_type TEXT NOT NULL DEFAULT 'live';
ALTER TABLE api_keys ADD COLUMN prefix TEXT;
ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '["full"]';
ALTER TABLE api_keys ADD COLUMN last_used_ip TEXT;
ALTER TABLE api_keys ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
ALTER TABLE api_keys ADD COLUMN created_by TEXT;
ALTER TABLE api_keys ADD COLUMN agent_ids TEXT;

CREATE TABLE IF NOT EXISTS api_key_audit_log (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  key_id TEXT,
  event TEXT NOT NULL,
  actor TEXT,
  ip TEXT,
  user_agent TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (key_id) REFERENCES api_keys(id),
  CHECK (event IN ('created', 'revoked', 'rotated', 'auth_failed', 'auth_success'))
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_status_account ON api_keys(account_id, status);
CREATE INDEX IF NOT EXISTS idx_api_key_audit_account ON api_key_audit_log(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_key_audit_key ON api_key_audit_log(key_id, created_at DESC);

UPDATE api_keys
SET
  key_type = COALESCE(key_type, 'live'),
  scopes = COALESCE(scopes, '["full"]'),
  prefix = COALESCE(prefix, 'mrw_legacy_****'),
  usage_count = COALESCE(usage_count, 0),
  created_by = COALESCE(created_by, 'signup')
WHERE 1 = 1;
