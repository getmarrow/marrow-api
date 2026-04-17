-- Tier 18: Marketplace

CREATE TABLE IF NOT EXISTS lesson_versions (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  changes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lesson_id) REFERENCES lessons(id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_versions_lesson ON lesson_versions(lesson_id);

CREATE TABLE IF NOT EXISTS lesson_ratings (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  review TEXT,
  rated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lesson_id) REFERENCES lessons(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_ratings_lesson ON lesson_ratings(lesson_id);
CREATE INDEX IF NOT EXISTS idx_lesson_ratings_account ON lesson_ratings(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lesson_ratings_unique ON lesson_ratings(lesson_id, account_id);

-- ALTER TABLE lessons ADD COLUMN published_at TEXT;
-- ALTER TABLE lessons ADD COLUMN published_by_account_id TEXT;
-- ALTER TABLE lessons ADD COLUMN fork_of_lesson_id TEXT;
-- ALTER TABLE lessons ADD COLUMN fork_count INTEGER DEFAULT 0;
-- ALTER TABLE lessons ADD COLUMN avg_rating REAL DEFAULT 0;
-- ALTER TABLE lessons ADD COLUMN rating_count INTEGER DEFAULT 0;

-- ALTER TABLE marketplace ADD COLUMN published INTEGER DEFAULT 0;
-- ALTER TABLE marketplace ADD COLUMN fork_count INTEGER DEFAULT 0;
