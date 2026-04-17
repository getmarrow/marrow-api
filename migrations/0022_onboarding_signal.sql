-- 0022: Onboarding Signal — track first think() call per account
ALTER TABLE accounts ADD COLUMN first_think_at TEXT;
