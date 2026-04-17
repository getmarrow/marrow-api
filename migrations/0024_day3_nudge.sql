-- Add email nudge tracking columns
ALTER TABLE accounts ADD COLUMN day3_nudge_sent_at TEXT;
ALTER TABLE accounts ADD COLUMN upgrade_nudge_sent_at TEXT;
