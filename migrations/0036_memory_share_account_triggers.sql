-- Enforce memory_shares.account_id matches the referenced memory account.
-- We use a trigger instead of a composite FK so legacy memories tables without
-- UNIQUE(id, account_id) can still be upgraded cleanly.

CREATE TRIGGER IF NOT EXISTS memory_shares_account_match_insert
BEFORE INSERT ON memory_shares
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM memories WHERE id = NEW.memory_id AND account_id = NEW.account_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory_shares account mismatch');
END;

CREATE TRIGGER IF NOT EXISTS memory_shares_account_match_update
BEFORE UPDATE OF memory_id, account_id ON memory_shares
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM memories WHERE id = NEW.memory_id AND account_id = NEW.account_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory_shares account mismatch');
END;
