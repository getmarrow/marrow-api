-- 0015: Owner tier + account tier upgrades
-- SQLite can't ALTER CHECK constraints, so owner tier is enforced in application code

-- Add owner tier config
INSERT OR IGNORE INTO tiers (id, name, retention_days, pii_strip, team_mode, webhooks, analytics, export, semantic_search)
VALUES ('tier_owner', 'owner', -1, 1, 1, 1, 1, 1, 1);

-- Upgrade accounts
UPDATE accounts SET tier = 'owner' WHERE id = 'acc-empirebuu-001';
UPDATE accounts SET tier = 'enterprise' WHERE id = '58ac3364-469d-4553-9f9b-486d6cf37e9a';
UPDATE accounts SET tier = 'enterprise' WHERE id = '31316b64-7918-4e5b-95e7-549199245841';
