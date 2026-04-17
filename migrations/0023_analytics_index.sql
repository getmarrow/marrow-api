-- M2 fix: Compound index on analytics_snapshots for behavioral drift + health score queries
CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_account_metric_time
ON analytics_snapshots(account_id, metric_name, recorded_at DESC);
