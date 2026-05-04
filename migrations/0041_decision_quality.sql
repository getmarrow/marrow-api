-- Mark low-value auto-log entries so they are retained for audit but excluded from training
ALTER TABLE decisions ADD COLUMN quality TEXT;
