-- 0018: Fix patterns table — remove UNIQUE on pattern_signature alone, 
-- keep UNIQUE on (account_id, pattern_signature)

-- Save existing data
CREATE TABLE IF NOT EXISTS patterns_backup AS SELECT * FROM patterns;

-- Drop and recreate with correct constraints
DROP TABLE IF EXISTS patterns;

CREATE TABLE patterns (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  pattern_signature TEXT NOT NULL,
  frequency INTEGER DEFAULT 0,
  confidence REAL DEFAULT 0,
  first_seen TEXT,
  last_seen TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (account_id, pattern_signature)
);

-- Restore data
INSERT OR IGNORE INTO patterns SELECT * FROM patterns_backup;

-- Cleanup
DROP TABLE IF EXISTS patterns_backup;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_patterns_account_id ON patterns(account_id);
CREATE INDEX IF NOT EXISTS idx_patterns_decision_type ON patterns(decision_type);
