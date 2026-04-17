-- Tier 14-15: Snapshots & Versioning, Snapshot Restore

CREATE TABLE IF NOT EXISTS snapshot_metadata (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  label TEXT,
  tags TEXT,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_metadata ON snapshot_metadata(snapshot_id);

CREATE TABLE IF NOT EXISTS snapshot_diffs (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  comparison_snapshot_id TEXT,
  decisions_added INTEGER DEFAULT 0,
  decisions_removed INTEGER DEFAULT 0,
  decisions_modified INTEGER DEFAULT 0,
  diff_data TEXT,
  calculated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_diffs ON snapshot_diffs(snapshot_id);

CREATE TABLE IF NOT EXISTS restore_jobs (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  decisions_restored INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_restore_jobs_status ON restore_jobs(status);
CREATE INDEX IF NOT EXISTS idx_restore_jobs_account ON restore_jobs(account_id);
