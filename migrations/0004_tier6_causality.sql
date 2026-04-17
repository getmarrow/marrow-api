-- Tier 6: Causal Reasoning

CREATE TABLE IF NOT EXISTS causality_edges (
  id TEXT PRIMARY KEY,
  from_decision_id TEXT NOT NULL,
  to_decision_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  strength REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (from_decision_id) REFERENCES decisions(id),
  FOREIGN KEY (to_decision_id) REFERENCES decisions(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_causality_from ON causality_edges(from_decision_id);
CREATE INDEX IF NOT EXISTS idx_causality_to ON causality_edges(to_decision_id);
CREATE INDEX IF NOT EXISTS idx_causality_account ON causality_edges(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_causality_unique ON causality_edges(from_decision_id, to_decision_id, account_id);

CREATE TABLE IF NOT EXISTS causality_stats (
  decision_id TEXT PRIMARY KEY,
  causal_depth INTEGER DEFAULT 0,
  incoming_count INTEGER DEFAULT 0,
  outgoing_count INTEGER DEFAULT 0,
  last_updated TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (decision_id) REFERENCES decisions(id)
);
