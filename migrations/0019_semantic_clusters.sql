-- 0019: Semantic clustering for pattern engine

CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  label TEXT NOT NULL,
  centroid TEXT,
  decision_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  last_seen TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_clusters_account ON clusters(account_id);
CREATE INDEX IF NOT EXISTS idx_clusters_label ON clusters(label);

-- Add cluster_id to decisions
ALTER TABLE decisions ADD COLUMN cluster_id TEXT REFERENCES clusters(id);

CREATE INDEX IF NOT EXISTS idx_decisions_cluster ON decisions(cluster_id);

-- Workflow sequence tracking
CREATE TABLE IF NOT EXISTS workflow_gaps (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  trigger_action TEXT NOT NULL,
  expected_followup TEXT NOT NULL,
  trigger_decision_id TEXT,
  detected_at TEXT NOT NULL,
  resolved INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_gaps_account ON workflow_gaps(account_id);
