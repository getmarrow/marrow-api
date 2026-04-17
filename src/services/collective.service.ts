/**
 * Feature 4: Anonymized Cross-Account Collective Patterns
 * Aggregates decisions across ALL accounts into anonymized patterns.
 * C1: No account-specific data ever leaks — only aggregated stats.
 * K-Anonymity: Minimum 5 distinct accounts per pattern before surfacing.
 */
import { CollectivePattern } from '../types';
import { uuid } from '../utils/crypto';

export class CollectiveService {
  constructor(private db: D1Database) {}

  /**
   * aggregatePatterns: Daily cron job.
   * Scans ALL decisions across ALL accounts (excluding opt-outs).
   * Groups by decision_type + action cluster, computes aggregates.
   * Requires minimum 5 accounts per pattern before surfacing.
   */
  async aggregatePatterns(): Promise<number> {
    // Get all non-opt-out accounts' decisions grouped by type
    const rows = await this.db.prepare(`
      SELECT
        d.account_id,
        d.decision_type,
        d.outcome_success,
        d.outcome,
        a.collective_opt_out
      FROM decisions d
      JOIN accounts a ON d.account_id = a.id
      WHERE a.collective_opt_out = 0
        AND d.outcome_recorded_at IS NOT NULL
        AND d.created_at > datetime('now', '-30 days')
      LIMIT 10000
    `).all<{ account_id: string; decision_type: string; outcome_success: number | null; outcome: string; collective_opt_out: number }>();

    // Group by decision_type
    const byType: Record<string, {
      accounts: Set<string>;
      total: number;
      success: number;
      failure: number;
      outcomes: string[];
    }> = {};

    for (const row of rows.results || []) {
      if (!byType[row.decision_type]) {
        byType[row.decision_type] = { accounts: new Set(), total: 0, success: 0, failure: 0, outcomes: [] };
      }
      byType[row.decision_type].accounts.add(row.account_id); // Track distinct accounts for k-anonymity
      byType[row.decision_type].total++;
      if (row.outcome_success === 1) byType[row.decision_type].success++;
      else if (row.outcome_success === 0) byType[row.decision_type].failure++;
      // Collect a sample of outcomes (anonymized)
      if (byType[row.decision_type].outcomes.length < 20) {
        byType[row.decision_type].outcomes.push(row.outcome || '');
      }
    }

    let processed = 0;
    for (const [decisionType, stats] of Object.entries(byType)) {
      if (stats.total < 5) continue; // Minimum sample size

      // Extract action cluster from outcomes (anonymized keyword extraction)
      const actionCluster = this.clusterOutcomes(decisionType, stats.outcomes);

      // Determine top failure reasons (anonymized)
      const topFailureReasons = this.extractFailureReasons(decisionType, stats.outcomes, stats.failure);

      const patternKey = `${decisionType}:${actionCluster}`;
      const successRate = stats.total > 0 ? stats.success / stats.total : 0;
      const accountCount = stats.accounts.size;

      // Only surface if k-anonymity threshold met
      if (accountCount < 5) continue;

      await this.db.prepare(`
        INSERT INTO collective_patterns (
          id, pattern_key, decision_type, action_cluster,
          total_decisions, success_count, failure_count, success_rate,
          top_failure_reasons, top_success_patterns, sample_size,
          account_count, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(pattern_key) DO UPDATE SET
          total_decisions = excluded.total_decisions,
          success_count = excluded.success_count,
          failure_count = excluded.failure_count,
          success_rate = excluded.success_rate,
          top_failure_reasons = excluded.top_failure_reasons,
          account_count = excluded.account_count,
          updated_at = datetime('now')
      `).bind(
        uuid(), patternKey, decisionType, actionCluster,
        stats.total, stats.success, stats.failure, successRate,
        JSON.stringify(topFailureReasons), JSON.stringify([]),
        stats.total, // L3: sample_size = total decisions analyzed (not account count)
        accountCount
      ).run();

      processed++;
    }

    return processed;
  }

  /**
   * getCollectiveInsight: Called from think() handler.
   * Returns anonymized insight for a given decision type.
   */
  async getCollectiveInsight(decisionType: string): Promise<{
    total_agents_reporting: number;
    decisions_analyzed: number;
    success_rate: number;
    top_failure_reasons: string[];
    insight: string;
  } | null> {
    const row = await this.db.prepare(`
      SELECT * FROM collective_patterns
      WHERE decision_type = ? AND account_count >= 5
      ORDER BY total_decisions DESC LIMIT 1
    `).bind(decisionType).first<{
      total_decisions: number; success_rate: number; top_failure_reasons: string;
      account_count: number;
    }>();

    if (!row) return null;

    const topFailureReasons = JSON.parse(row.top_failure_reasons || '[]');
    const insight = `Across all agents, this type of decision succeeds ${(row.success_rate * 100).toFixed(0)}% of the time.`;

    return {
      total_agents_reporting: row.account_count,
      decisions_analyzed: row.total_decisions,
      success_rate: row.success_rate,
      top_failure_reasons: topFailureReasons.slice(0, 5),
      insight,
    };
  }

  /**
   * clusterOutcomes: Simple keyword extraction for anonymization.
   * Returns a generic label for the cluster.
   */
  private clusterOutcomes(decisionType: string, outcomes: string[]): string {
    const text = outcomes.join(' ').toLowerCase();
    const keywords = ['deploy', 'test', 'config', 'build', 'fix', 'update', 'refactor', 'security', 'database', 'migration'];
    for (const kw of keywords) {
      if (text.includes(kw)) return kw;
    }
    return decisionType;
  }

  /**
   * extractFailureReasons: Anonymized extraction of failure patterns.
   * Returns generic failure labels, never raw text.
   */
  private extractFailureReasons(decisionType: string, outcomes: string[], failureCount: number): string[] {
    if (failureCount === 0) return [];

    const text = outcomes.join(' ').toLowerCase();
    const reasons: string[] = [];

    if (text.includes('config') || text.includes('configuration')) reasons.push('configuration mismatch');
    if (text.includes('test') || text.includes('fail')) reasons.push('test failures');
    if (text.includes('permission') || text.includes('access')) reasons.push('permission issues');
    if (text.includes('timeout') || text.includes('slow')) reasons.push('timeout or performance');
    if (text.includes('merge') || text.includes('conflict')) reasons.push('merge conflicts');
    if (text.includes('deploy')) reasons.push('deployment errors');

    return reasons.slice(0, 3);
  }
}
