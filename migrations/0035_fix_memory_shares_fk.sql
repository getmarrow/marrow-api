-- Fix memory_shares composite FK — memories table has no UNIQUE(id, account_id),
-- only id PRIMARY KEY. Recreate memory_shares referencing memories(id) only.

CREATE TABLE memory_shares_new (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (memory_id) REFERENCES memories(id),
  UNIQUE (memory_id, account_id, agent_id)
);

INSERT INTO memory_shares_new SELECT * FROM memory_shares;

DROP TABLE memory_shares;

ALTER TABLE memory_shares_new RENAME TO memory_shares;

CREATE INDEX IF NOT EXISTS idx_memory_shares_account_agent ON memory_shares(account_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_shares_memory_id ON memory_shares(memory_id);
