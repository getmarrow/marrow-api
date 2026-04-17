-- Tier 3: Outcome Feedback

CREATE TABLE IF NOT EXISTS outcomes (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  success INTEGER NOT NULL,
  feedback TEXT,
  details TEXT,
  recorded_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (decision_id) REFERENCES decisions(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_outcomes_decision ON outcomes(decision_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_account ON outcomes(account_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_recorded ON outcomes(recorded_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outcomes_unique_per_decision ON outcomes(decision_id, account_id) WHERE success IS NOT NULL;
