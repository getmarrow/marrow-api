-- Canonical rebuild of the memories table.
-- Goal: remove legacy unused columns while preserving live data, FK relationships,
-- FTS indexing, and current API expectations.
--
-- Legacy columns being removed:
--   supersedes_id, superseded_by_id, agent_id, session_id,
--   shared_with, shared_by, shared_at
--
-- Canonical columns retained:
--   id, account_id, text, source, tags, status,
--   supersedes, superseded_by, deleted_at, audit,
--   created_at, updated_at

PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS memory_shares_account_match_insert;
DROP TRIGGER IF EXISTS memory_shares_account_match_update;
DROP TRIGGER IF EXISTS memories_ai;
DROP TRIGGER IF EXISTS memories_ad;
DROP TRIGGER IF EXISTS memories_au;
DROP TABLE IF EXISTS memories_fts;

CREATE TABLE memories_rebuild (
  id TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) < 128),
  account_id TEXT NOT NULL CHECK (length(account_id) > 0 AND length(account_id) < 200),
  text TEXT NOT NULL CHECK (length(text) > 0 AND length(text) < 50000),
  source TEXT,
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'outdated', 'superseded', 'deleted')),
  supersedes TEXT REFERENCES memories_rebuild(id),
  superseded_by TEXT REFERENCES memories_rebuild(id),
  deleted_at TEXT,
  audit TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(audit) AND json_type(audit) = 'array'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO memories_rebuild (
  rowid,
  id,
  account_id,
  text,
  source,
  tags,
  status,
  supersedes,
  superseded_by,
  deleted_at,
  audit,
  created_at,
  updated_at
)
SELECT
  rowid,
  id,
  account_id,
  text,
  source,
  CASE
    WHEN json_valid(tags) AND json_type(tags) = 'array' THEN tags
    ELSE '[]'
  END,
  status,
  COALESCE(supersedes, supersedes_id),
  COALESCE(superseded_by, superseded_by_id),
  deleted_at,
  CASE
    WHEN json_valid(audit) AND json_type(audit) = 'array' THEN audit
    ELSE '[]'
  END,
  created_at,
  updated_at
FROM memories;

DROP TABLE memories;
ALTER TABLE memories_rebuild RENAME TO memories;

CREATE INDEX idx_memories_account_status ON memories(account_id, status, updated_at DESC);
CREATE INDEX idx_memories_account_updated_at ON memories(account_id, updated_at DESC);
CREATE INDEX idx_memories_account_created ON memories(account_id, created_at DESC);
CREATE INDEX idx_memories_source ON memories(source);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  text,
  content='memories',
  content_rowid='rowid'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;

INSERT INTO memories_fts(memories_fts) VALUES('rebuild');

CREATE TRIGGER memory_shares_account_match_insert
BEFORE INSERT ON memory_shares
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM memories WHERE id = NEW.memory_id AND account_id = NEW.account_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory_shares account mismatch');
END;

CREATE TRIGGER memory_shares_account_match_update
BEFORE UPDATE OF memory_id, account_id ON memory_shares
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM memories WHERE id = NEW.memory_id AND account_id = NEW.account_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory_shares account mismatch');
END;

PRAGMA foreign_keys = ON;
