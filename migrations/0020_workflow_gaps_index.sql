-- 0020: Add composite index for workflow gap queries
CREATE INDEX IF NOT EXISTS idx_workflow_gaps_account_resolved ON workflow_gaps(account_id, resolved);
