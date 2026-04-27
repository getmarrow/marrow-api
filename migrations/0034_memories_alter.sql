-- Align memories table column names to new API code expectations.
-- The table was created with supersedes_id/superseded_by_id; new code uses supersedes/superseded_by.
-- Also adds the audit column used for per-memory audit trails.

ALTER TABLE memories ADD COLUMN supersedes TEXT;
ALTER TABLE memories ADD COLUMN superseded_by TEXT;
ALTER TABLE memories ADD COLUMN audit TEXT NOT NULL DEFAULT '[]';

-- Back-fill from old columns so existing data isn't orphaned
UPDATE memories SET supersedes = supersedes_id WHERE supersedes_id IS NOT NULL;
UPDATE memories SET superseded_by = superseded_by_id WHERE superseded_by_id IS NOT NULL;
