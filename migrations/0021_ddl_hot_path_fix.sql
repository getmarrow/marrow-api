-- H2 fix: Move DDL from hot request paths to migration
-- These tables were previously created via CREATE TABLE IF NOT EXISTS on every request

-- Drop old rate_limits table (had incompatible schema from prior migration)
DROP TABLE IF EXISTS rate_limits;

CREATE TABLE rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  "key" TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_rate_limits_key_created ON rate_limits("key", created_at);

CREATE TABLE IF NOT EXISTS email_otps (
  email TEXT PRIMARY KEY,
  otp TEXT,
  expires_at TEXT,
  created_at TEXT
);
