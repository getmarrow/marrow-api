-- Tier 8: Pattern Recognition

CREATE TABLE IF NOT EXISTS pattern_tests (
  id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  matched INTEGER DEFAULT 0,
  confidence REAL DEFAULT 0,
  tested_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (pattern_id) REFERENCES patterns(id),
  FOREIGN KEY (decision_id) REFERENCES decisions(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_pattern_tests_pattern ON pattern_tests(pattern_id);
CREATE INDEX IF NOT EXISTS idx_pattern_tests_account ON pattern_tests(account_id);
CREATE INDEX IF NOT EXISTS idx_pattern_tests_matched ON pattern_tests(matched);

CREATE TABLE IF NOT EXISTS pattern_results (
  id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  total_tests INTEGER DEFAULT 0,
  successful_tests INTEGER DEFAULT 0,
  accuracy REAL DEFAULT 0,
  last_updated TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (pattern_id) REFERENCES patterns(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_pattern_results_account ON pattern_results(account_id);
