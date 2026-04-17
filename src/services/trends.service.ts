/**
 * Feature 3: Success Rate Trend Tracking
 * Stores daily stats so dashboard can show improvement over time.
 * C1: All queries scoped to accountId.
 */
import { DailyStats } from '../types';
import { uuid, now } from '../utils/crypto';

export class TrendsService {
  constructor(private db: D1Database) {}

  /**
   * rollupDaily: Called via cron. Computes yesterday's daily stats for all accounts
   * that have decisions. Runs once per day (caller should check date change).
   * Returns count of accounts processed.
   */
  async rollupDaily(): Promise<number> {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    // Get all accounts that have decisions in the date range
    const accounts = await this.db.prepare(
      `SELECT DISTINCT account_id FROM decisions WHERE date(created_at) = ?`,
    ).bind(yesterday).all<{ account_id: string }>();

    let processed = 0;
    for (const row of accounts.results || []) {
      const accountId = row.account_id;
      // L2 fix: Per-account error handling so one bad account doesn't block all others
      try {

      // Get totals
      const totals = await this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as successful,
          SUM(CASE WHEN outcome_success = 0 THEN 1 ELSE 0 END) as failed
        FROM decisions
        WHERE account_id = ? AND date(created_at) = ?
      `).bind(accountId, yesterday).first<{ total: number; successful: number; failed: number }>();

      if (!totals) continue;

      // Get breakdown by type
      const byTypeRows = await this.db.prepare(`
        SELECT decision_type, COUNT(*) as count
        FROM decisions
        WHERE account_id = ? AND date(created_at) = ?
        GROUP BY decision_type
      `).bind(accountId, yesterday).all<{ decision_type: string; count: number }>();

      const byType: Record<string, number> = {};
      for (const r of byTypeRows.results || []) {
        byType[r.decision_type] = r.count;
      }

      const successRate = totals.total > 0 ? totals.successful / totals.total : 0;

      // Upsert daily stat
      await this.db.prepare(`
        INSERT INTO daily_stats (id, account_id, date, total_decisions, successful_decisions, failed_decisions, success_rate, by_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, date) DO UPDATE SET
          total_decisions = excluded.total_decisions,
          successful_decisions = excluded.successful_decisions,
          failed_decisions = excluded.failed_decisions,
          success_rate = excluded.success_rate,
          by_type = excluded.by_type
      `).bind(
        uuid(), accountId, yesterday,
        totals.total, totals.successful, totals.failed,
        successRate, JSON.stringify(byType), now()
      ).run();

      processed++;

      } catch (e) {
        console.error(`[trends] rollup failed for account ${accountId}:`, e);
      }
    }

    return processed;
  }

  /**
   * getTrend: Return daily_stats rows for the last N days.
   */
  async getTrend(accountId: string, days: number = 30): Promise<DailyStats[]> {
    const rows = await this.db.prepare(`
      SELECT * FROM daily_stats
      WHERE account_id = ?
      ORDER BY date DESC
      LIMIT ?
    `).bind(accountId, days).all<{
      id: string; account_id: string; date: string; total_decisions: number;
      successful_decisions: number; failed_decisions: number; success_rate: number;
      by_type: string; created_at: string;
    }>();

    return (rows.results || []).map(r => ({
      id: r.id,
      account_id: r.account_id,
      date: r.date,
      total_decisions: r.total_decisions,
      successful_decisions: r.successful_decisions,
      failed_decisions: r.failed_decisions,
      success_rate: r.success_rate,
      by_type: JSON.parse(r.by_type || '{}'),
      created_at: r.created_at,
    }));
  }

  /**
   * getImprovement: Compare last 7d success rate to prior 7d.
   * Returns delta (positive = improving) and direction string.
   */
  async getImprovement(accountId: string): Promise<{ delta: number; direction: 'improving' | 'declining' | 'stable' }> {
    const recent = await this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as successful
      FROM decisions
      WHERE account_id = ? AND created_at > datetime('now', '-7 days')
    `).bind(accountId).first<{ total: number; successful: number }>();

    const prior = await this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as successful
      FROM decisions
      WHERE account_id = ?
        AND created_at > datetime('now', '-14 days')
        AND created_at <= datetime('now', '-7 days')
    `).bind(accountId).first<{ total: number; successful: number }>();

    const recentRate = recent && recent.total > 0 ? recent.successful / recent.total : 0;
    const priorRate = prior && prior.total > 0 ? prior.successful / prior.total : 0;
    const delta = recentRate - priorRate;

    let direction: 'improving' | 'declining' | 'stable' = 'stable';
    if (delta > 0.01) direction = 'improving';
    else if (delta < -0.01) direction = 'declining';

    return { delta, direction };
  }

  /**
   * getSuccessRate: Get success rate for a time window.
   */
  async getSuccessRate(accountId: string, days: number): Promise<number> {
    const row = await this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as successful
      FROM decisions
      WHERE account_id = ? AND created_at > datetime('now', ?)
    `).bind(accountId, `-${days} days`).first<{ total: number; successful: number }>();

    if (!row || row.total === 0) return 0;
    return row.successful / row.total;
  }
}
