-- Tier 13: Hive Consensus

CREATE TABLE IF NOT EXISTS consensus_analysis (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  total_votes INTEGER DEFAULT 0,
  agree_count INTEGER DEFAULT 0,
  disagree_count INTEGER DEFAULT 0,
  abstain_count INTEGER DEFAULT 0,
  consensus_ratio REAL DEFAULT 0,
  analyzed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (decision_id) REFERENCES decisions(id)
);

CREATE INDEX IF NOT EXISTS idx_consensus_decision ON consensus_analysis(decision_id);

ALTER TABLE consensus_votes ADD COLUMN vote_type TEXT DEFAULT 'agree';
ALTER TABLE consensus_votes ADD COLUMN agent_id TEXT;
ALTER TABLE consensus_votes ADD COLUMN reasoning TEXT;
