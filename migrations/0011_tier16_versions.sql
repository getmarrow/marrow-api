-- Tier 16: Version History

CREATE TABLE IF NOT EXISTS migration_guides (
  id TEXT PRIMARY KEY,
  from_version TEXT NOT NULL,
  to_version TEXT NOT NULL,
  guide TEXT NOT NULL,
  breaking_changes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_migration_guides_versions ON migration_guides(from_version, to_version);

CREATE TABLE IF NOT EXISTS deprecation_warnings (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  deprecated_in TEXT NOT NULL,
  removed_in TEXT,
  replacement_endpoint TEXT,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deprecation_endpoint ON deprecation_warnings(endpoint);

-- ALTER TABLE versions ADD COLUMN breaking_changes TEXT; -- already exists from schema.sql
