-- Migration 0026: Add hive contribution control at org level
-- Enables "private org hive" (Enterprise) — agents learn from each other internally
-- but can optionally opt out of contributing to the global hive
-- hive_contribution = 1 (default): org contributes anonymous signals to global hive
-- hive_contribution = 0: org reads global hive patterns but contributes nothing (hive reader mode)

ALTER TABLE orgs ADD COLUMN hive_contribution INTEGER NOT NULL DEFAULT 1;

-- Also add default_visibility for org — controls what visibility new decisions get
-- 'hive' (default): contributes to global hive anonymously
-- 'team': only shared within org, not global hive
-- 'private': completely isolated, no hive contribution
ALTER TABLE orgs ADD COLUMN default_visibility TEXT NOT NULL DEFAULT 'hive';
