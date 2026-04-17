-- Fix schema mismatches between code and D1

-- audit_log: add missing columns for hash chain + resource tracking
ALTER TABLE audit_log ADD COLUMN timestamp TEXT;
ALTER TABLE audit_log ADD COLUMN resource_id TEXT;
ALTER TABLE audit_log ADD COLUMN hash TEXT;
ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;

-- safety_violations: add missing columns for severity-based tracking
ALTER TABLE safety_violations ADD COLUMN severity TEXT DEFAULT 'low';
ALTER TABLE safety_violations ADD COLUMN action_taken TEXT DEFAULT 'log';
ALTER TABLE safety_violations ADD COLUMN details TEXT;
ALTER TABLE safety_violations ADD COLUMN created_at TEXT DEFAULT (datetime('now'));

-- Make decision_id nullable in safety_violations (code passes null for pre-insert checks)
-- SQLite doesn't support ALTER COLUMN, but the NOT NULL constraint on decision_id
-- means we need to recreate. However, since we can't drop columns in SQLite easily,
-- and the existing data likely has no rows, we'll handle this in code instead.

-- Add outcome tracking columns to decisions (if missing)
-- These are used by recordOutcome
ALTER TABLE decisions ADD COLUMN outcome_success INTEGER;
ALTER TABLE decisions ADD COLUMN outcome_recorded_at TEXT;
ALTER TABLE decisions ADD COLUMN outcome_details TEXT;

-- Indexes for audit performance
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_account ON audit_log(account_id);
