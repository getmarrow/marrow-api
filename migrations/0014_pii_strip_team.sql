-- 0014: Add pii_strip_team setting to orgs (default OFF)
ALTER TABLE orgs ADD COLUMN pii_strip_team INTEGER NOT NULL DEFAULT 0;
