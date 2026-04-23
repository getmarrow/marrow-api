import { VelocityService } from './velocity.service';
import { BaselineService } from './baseline.service';

/**
 * Feature 1: Operator Dashboard API
 * Single endpoint showing everything about agents' health, performance, and Marrow's impact.
 * C1: All queries scoped to accountId.
 */

export class DashboardService {
  constructor(private db: D1Database) {}

  /**
   * getDashboard: Build the full dashboard response.
   */
  async getDashboard(accountId: string): Promise<Record<string, unknown>> {
    const velocityService = new VelocityService(this.db);
    const baselineService = new BaselineService(this.db);
    const [
      accountInfo,
      health,
      topFailures,
      workflowStatus,
      recentDecisions,
      savesInfo,
      attemptsPerSuccess,
      timeToSuccess,
      driftRate,
      improvement,
    ] = await Promise.all([
      this.getAccountInfo(accountId),
      this.getHealth(accountId),
      this.getTopFailures(accountId),
      this.getWorkflowStatus(accountId),
      this.getRecentDecisions(accountId),
      this.getSavesInfo(accountId),
      velocityService.getAttemptsPerSuccess(accountId),
      velocityService.getTimeToSuccess(accountId),
      velocityService.getDriftRate(accountId),
      baselineService.getAccountImprovement(accountId),
    ]);

    return {
      account: accountInfo,
      health,
      top_failures: topFailures,
      workflow_status: workflowStatus,
      impact: savesInfo,
      velocity: {
        attempts_per_success: attemptsPerSuccess,
        time_to_success_seconds: timeToSuccess,
        drift_rate: driftRate,
      },
      improvement: improvement,
      recent_decisions: recentDecisions,
    };
  }

  private async getAccountInfo(accountId: string): Promise<{
    agent_count: number;
    total_decisions: number;
    active_since: string;
  }> {
    const agentCount = await this.db.prepare(`
      SELECT COUNT(DISTINCT session_id) as c FROM decisions WHERE account_id = ? AND session_id IS NOT NULL
    `).bind(accountId).first<{ c: number }>();

    const totalDecisions = await this.db.prepare(`
      SELECT COUNT(*) as c FROM decisions WHERE account_id = ?
    `).bind(accountId).first<{ c: number }>();

    const activeSince = await this.db.prepare(`
      SELECT MIN(created_at) as earliest FROM decisions WHERE account_id = ? LIMIT 1
    `).bind(accountId).first<{ earliest: string | null }>();

    // P6 fix: If session_id is NULL for pre-migration decisions, fall back to 1 if decisions exist
    const rawAgentCount = agentCount?.c || 0;
    const totalCount = totalDecisions?.c || 0;
    const effectiveAgentCount = rawAgentCount === 0 && totalCount > 0 ? 1 : rawAgentCount;

    return {
      agent_count: effectiveAgentCount,
      total_decisions: totalCount,
      active_since: activeSince?.earliest || new Date().toISOString(),
    };
  }

  private async getHealth(accountId: string): Promise<{
    overall_score: number;
    label: string;
    success_rate_7d: number;
    success_rate_30d: number;
    trend: string;
    trend_delta: number;
  }> {
    const [rate7d, rate30d] = await Promise.all([
      this.getSuccessRate(accountId, 7),
      this.getSuccessRate(accountId, 30),
    ]);

    const trendDelta = rate7d - rate30d;
    let trend: string;
    if (trendDelta > 0.01) trend = 'improving';
    else if (trendDelta < -0.01) trend = 'declining';
    else trend = 'stable';

    const overallScore = Math.round(rate7d * 100);
    const label = overallScore >= 80 ? 'good' : overallScore >= 60 ? 'fair' : 'needs attention';

    return {
      overall_score: overallScore,
      label,
      success_rate_7d: rate7d,
      success_rate_30d: rate30d,
      trend,
      trend_delta: trendDelta,
    };
  }

  private async getSuccessRate(accountId: string, days: number): Promise<number> {
    const row = await this.db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as success
      FROM decisions
      WHERE account_id = ?
        AND created_at > datetime('now', ?)
        AND outcome_recorded_at IS NOT NULL
        AND outcome_success IS NOT NULL
    `).bind(accountId, `-${days} days`).first<{ total: number; success: number }>();

    if (!row || row.total === 0) return 0;
    return row.success / row.total;
  }

  private async getTopFailures(accountId: string): Promise<Array<{
    decision_type: string;
    failure_rate: number;
    count: number;
    last_seen: string;
    top_reason: string | null;
  }>> {
    const rows = await this.db.prepare(`
      SELECT
        decision_type,
        COUNT(*) as total,
        SUM(CASE WHEN outcome_success = 0 THEN 1 ELSE 0 END) as failures,
        MAX(created_at) as last_seen
      FROM decisions
      WHERE account_id = ?
        AND created_at > datetime('now', '-7 days')
        AND outcome_recorded_at IS NOT NULL
        AND outcome_success IS NOT NULL
      GROUP BY decision_type
      HAVING failures > 0
      ORDER BY failures DESC
      LIMIT 5
    `).bind(accountId).all<{
      decision_type: string; total: number; failures: number; last_seen: string;
    }>();

    // P5 fix: Extract actual top failure reason from most common failed outcome
    const results: Array<{ decision_type: string; failure_rate: number; count: number; last_seen: string; top_reason: string | null }> = [];
    for (const r of rows.results || []) {
      let topReason: string | null = null;
      try {
        const reasonRow = await this.db.prepare(`
          SELECT outcome, COUNT(*) as n
          FROM decisions
          WHERE account_id = ? AND decision_type = ? AND outcome_success = 0
            AND created_at > datetime('now', '-7 days')
          GROUP BY outcome
          ORDER BY n DESC
          LIMIT 1
        `).bind(accountId, r.decision_type).first<{ outcome: string; n: number }>();
        if (reasonRow?.outcome) {
          topReason = reasonRow.outcome.slice(0, 120);
        }
      } catch { /* fall through to null */ }
      results.push({
        decision_type: r.decision_type,
        failure_rate: r.failures / r.total,
        count: r.failures,
        last_seen: r.last_seen,
        top_reason: topReason,
      });
    }
    return results;
  }

  private async getWorkflowStatus(accountId: string): Promise<{
    active: number;
    completed_this_week: number;
    stalled: number;
    stalled_workflows: Array<{
      instance_id: string;
      workflow_name: string;
      stalled_at_step: number;
      stalled_since: string;
      waiting_for: string;
    }>;
  }> {
    const [activeRows, completedRows, runningRows] = await Promise.all([
      this.db.prepare(`
        SELECT COUNT(*) as c FROM workflow_instances wi
        JOIN workflows w ON wi.workflow_id = w.id
        WHERE w.account_id = ? AND wi.status = 'running'
      `).bind(accountId).first<{ c: number }>(),
      this.db.prepare(`
        SELECT COUNT(*) as c FROM workflow_instances wi
        JOIN workflows w ON wi.workflow_id = w.id
        WHERE w.account_id = ? AND wi.status = 'completed'
          AND wi.completed_at > datetime('now', '-7 days')
      `).bind(accountId).first<{ c: number }>(),
      this.db.prepare(`
        SELECT wi.id as instance_id, wi.current_step, wi.started_at, wi.context,
               w.name as workflow_name
        FROM workflow_instances wi
        JOIN workflows w ON wi.workflow_id = w.id
        WHERE w.account_id = ? AND wi.status = 'running'
          AND wi.started_at < datetime('now', '-3 days')
      `).bind(accountId).all<{
        instance_id: string; current_step: number; started_at: string;
        workflow_name: string; context: string;
      }>(),
    ]);

    const stalledWorkflows = (runningRows.results || []).map(r => {
      let context: { agent_id?: string } = {};
      try { context = JSON.parse(r.context || '{}'); } catch { /* ignore */ }
      return {
        instance_id: r.instance_id,
        workflow_name: r.workflow_name,
        stalled_at_step: r.current_step,
        stalled_since: r.started_at,
        waiting_for: context.agent_id || 'next agent',
      };
    });

    return {
      active: activeRows?.c || 0,
      completed_this_week: completedRows?.c || 0,
      stalled: stalledWorkflows.length,
      stalled_workflows: stalledWorkflows,
    };
  }

  private async getRecentDecisions(accountId: string): Promise<{
    today: number;
    this_week: number;
    by_type: Record<string, number>;
  }> {
    const [todayRows, weekRows] = await Promise.all([
      this.db.prepare(`
        SELECT COUNT(*) as c, decision_type as dt
        FROM decisions WHERE account_id = ? AND date(created_at) = date('now')
        GROUP BY decision_type
      `).bind(accountId).all<{ c: number; dt: string }>(),
      this.db.prepare(`
        SELECT COUNT(*) as c, decision_type as dt
        FROM decisions WHERE account_id = ? AND created_at > datetime('now', '-7 days')
        GROUP BY decision_type
      `).bind(accountId).all<{ c: number; dt: string }>(),
    ]);

    const byType: Record<string, number> = {};
    for (const r of weekRows.results || []) {
      byType[r.dt] = r.c;
    }

    const today = (todayRows.results || []).reduce((sum, r) => sum + r.c, 0);
    const thisWeek = (weekRows.results || []).reduce((sum, r) => sum + r.c, 0);

    return { today, this_week: thisWeek, by_type: byType };
  }

  private async getSavesInfo(accountId: string): Promise<{
    saves_this_week: number;
    saves_total: number;
    failures_prevented_details: Array<{
      action: string;
      warning_given: string;
      outcome: string;
    }>;
  }> {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    const [weekSaves, totalSaves] = await Promise.all([
      this.db.prepare(`
        SELECT COUNT(*) as c FROM saves WHERE account_id = ? AND confirmed_save = 1 AND created_at > ?
      `).bind(accountId, weekAgo).first<{ c: number }>(),
      this.db.prepare(`
        SELECT COUNT(*) as c FROM saves WHERE account_id = ? AND confirmed_save = 1
      `).bind(accountId).first<{ c: number }>(),
    ]);

    const detailRows = await this.db.prepare(`
      SELECT s.warning_message, d.outcome, d.context
      FROM saves s
      JOIN decisions d ON s.decision_id = d.id
      WHERE s.account_id = ? AND s.confirmed_save = 1
      ORDER BY s.created_at DESC LIMIT 3
    `).bind(accountId).all<{ warning_message: string; outcome: string; context: string }>();

    const failures_prevented_details = (detailRows.results || []).map(r => {
      let action = 'agent action';
      try {
        const ctx = JSON.parse(r.context);
        action = typeof ctx.action === 'string' ? ctx.action.slice(0, 60) :
          typeof ctx.description === 'string' ? ctx.description.slice(0, 60) : action;
      } catch { /* use default */ }
      return {
        action,
        warning_given: r.warning_message.slice(0, 120),
        outcome: r.outcome?.slice(0, 120) || 'success',
      };
    });

    return {
      saves_this_week: weekSaves?.c || 0,
      saves_total: totalSaves?.c || 0,
      failures_prevented_details,
    };
  }
}
