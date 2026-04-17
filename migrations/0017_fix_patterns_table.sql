-- 0017: Add missing columns to patterns table
ALTER TABLE patterns ADD COLUMN first_seen TEXT;
ALTER TABLE patterns ADD COLUMN last_seen TEXT;

-- Add unique index (can't add UNIQUE constraint to existing table, but index works)
CREATE UNIQUE INDEX IF NOT EXISTS idx_patterns_account_sig ON patterns(account_id, pattern_signature);
