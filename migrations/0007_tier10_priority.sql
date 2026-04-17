-- Tier 10: Priority Queue

CREATE TABLE IF NOT EXISTS decision_priority (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  score REAL DEFAULT 0.5,
  urgency TEXT DEFAULT 'normal',
  impact REAL DEFAULT 0,
  effective_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (decision_id) REFERENCES decisions(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_priority_account ON decision_priority(account_id);
CREATE INDEX IF NOT EXISTS idx_priority_score ON decision_priority(score DESC);
CREATE INDEX IF NOT EXISTS idx_priority_urgency ON decision_priority(urgency);
CREATE INDEX IF NOT EXISTS idx_priority_expires ON decision_priority(expires_at);

CREATE TABLE IF NOT EXISTS queue_status (
  account_id TEXT PRIMARY KEY,
  total_decisions INTEGER DEFAULT 0,
  high_priority_count INTEGER DEFAULT 0,
  avg_score REAL DEFAULT 0.5,
  last_recalc TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
