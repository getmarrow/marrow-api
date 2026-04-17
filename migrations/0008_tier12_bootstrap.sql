-- Tier 12: Bootstrap Templates (idempotent)

CREATE TABLE IF NOT EXISTS bootstrap_instances (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  instantiated_decisions TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (template_id) REFERENCES bootstrap_templates(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_bootstrap_instances_template ON bootstrap_instances(template_id);
CREATE INDEX IF NOT EXISTS idx_bootstrap_instances_account ON bootstrap_instances(account_id);
