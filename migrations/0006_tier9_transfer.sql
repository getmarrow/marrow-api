-- Tier 9: Transfer Learning

CREATE TABLE IF NOT EXISTS transfer_history (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  from_domain TEXT NOT NULL,
  to_domain TEXT NOT NULL,
  effectiveness REAL DEFAULT 0,
  applied_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lesson_id) REFERENCES lessons(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_transfer_lesson ON transfer_history(lesson_id);
CREATE INDEX IF NOT EXISTS idx_transfer_account ON transfer_history(account_id);
CREATE INDEX IF NOT EXISTS idx_transfer_domains ON transfer_history(from_domain, to_domain);

CREATE TABLE IF NOT EXISTS transfer_metrics (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  from_domain TEXT NOT NULL,
  to_domain TEXT NOT NULL,
  transfer_count INTEGER DEFAULT 0,
  avg_effectiveness REAL DEFAULT 0,
  last_updated TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_transfer_metrics_account ON transfer_metrics(account_id);
