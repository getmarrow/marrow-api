-- Persistent memories for SDK/MCP memory control surface
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  supersedes TEXT,
  superseded_by TEXT,
  deleted_at TEXT,
  audit TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (supersedes) REFERENCES memories(id),
  FOREIGN KEY (superseded_by) REFERENCES memories(id),
  UNIQUE (id, account_id),
  CHECK (status IN ('active', 'outdated', 'superseded', 'deleted'))
);

CREATE TABLE IF NOT EXISTS memory_shares (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (memory_id, account_id) REFERENCES memories(id, account_id),
  UNIQUE (memory_id, account_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_memories_account_status ON memories(account_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_account_updated_at ON memories(account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_shares_account_agent ON memory_shares(account_id, agent_id);
