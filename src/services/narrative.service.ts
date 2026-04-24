import type { D1Database } from '@cloudflare/workers-types';
import { BaselineService } from './baseline.service';

interface LatestCommitRow {
  outcome_recorded_at: string;
}

interface AccountBaselineRow {
  captured_at: string;
  attempts_per_success: number;
  time_to_success_seconds: number;
}

interface WeeklyDeltaRow {
  delta_seconds: number;
  recorded_at_ms: number;
}

const MILESTONES = new Set([100, 500, 1000, 5000]);
const BASELINE_CAPTURE_WINDOW_MS = 5_000;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export class NarrativeService {
  constructor(private db: D1Database) {}

  /**
   * Returns a human-readable narrative string for this commit event, or null if no trigger fires.
   * Called from commit handler AFTER the decision has been recorded.
   */
  async getNarrativeForCommit(accountId: string, agentId?: string): Promise<string | null> {
    const latestCommit = await this.getLatestCommit(accountId, agentId);
    if (!latestCommit?.outcome_recorded_at) return null;

    const totalCommits = await this.getTotalCommits(accountId);
    if (totalCommits === 1) {
      return "Marrow is now tracking your agent's decisions. I'll share your first improvement baseline once you reach 7 days or 20 decisions.";
    }

    const baselineService = new BaselineService(this.db);
    await baselineService.captureAccountBaselineIfEligible(accountId).catch(() => {});

    const baseline = await this.getAccountBaseline(accountId);
    if (baseline && this.wasCapturedByThisCommit(baseline.captured_at, latestCommit.outcome_recorded_at)) {
      return `Baseline captured. Your first-week averages: ${this.formatNumber(baseline.time_to_success_seconds)}s per task, ${this.formatNumber(baseline.attempts_per_success)} attempts per success. I'll compare future decisions against this.`;
    }

    if (baseline && MILESTONES.has(totalCommits)) {
      const improvement = await baselineService.getAccountImprovement(accountId);
      if (improvement.status === 'active') {
        const timeDeltaPct = Math.abs(improvement.time_to_success_seconds.delta_pct);
        const attemptsDeltaPct = Math.abs(improvement.attempts_per_success.delta_pct);
        const fasterOrSlower = improvement.time_to_success_seconds.delta_pct <= 0 ? 'faster' : 'slower';
        const fewerOrMore = improvement.attempts_per_success.delta_pct <= 0 ? 'fewer' : 'more';
        return `Milestone: ${totalCommits} decisions logged since you started with Marrow. Since baseline you're ${this.formatNumber(timeDeltaPct)}% ${fasterOrSlower} with ${this.formatNumber(attemptsDeltaPct)}% ${fewerOrMore} attempts per success.`;
      }
    }

    return this.buildWeeklyRecap(accountId, latestCommit.outcome_recorded_at);
  }

  private async getLatestCommit(accountId: string, agentId?: string): Promise<LatestCommitRow | null> {
    const agentClause = agentId ? ' AND COALESCE(agent_id, session_id) = ?' : '';
    const bindings: string[] = [accountId];
    if (agentId) bindings.push(agentId);

    return this.db
      .prepare(`
        SELECT outcome_recorded_at
        FROM decisions
        WHERE account_id = ?
          AND outcome_recorded_at IS NOT NULL
          ${agentClause}
        ORDER BY outcome_recorded_at DESC
        LIMIT 1
      `)
      .bind(...bindings)
      .first<LatestCommitRow>();
  }

  private async getTotalCommits(accountId: string): Promise<number> {
    const row = await this.db
      .prepare(`
        SELECT COUNT(*) AS c
        FROM decisions
        WHERE account_id = ?
          AND outcome_recorded_at IS NOT NULL
      `)
      .bind(accountId)
      .first<{ c: number }>();

    return row?.c || 0;
  }

  private async getAccountBaseline(accountId: string): Promise<AccountBaselineRow | null> {
    return this.db
      .prepare(`
        SELECT captured_at, attempts_per_success, time_to_success_seconds
        FROM account_baselines
        WHERE account_id = ?
        LIMIT 1
      `)
      .bind(accountId)
      .first<AccountBaselineRow>();
  }

  private wasCapturedByThisCommit(capturedAt: string, commitAt: string): boolean {
    const capturedMs = Date.parse(capturedAt);
    const commitMs = Date.parse(commitAt);
    if (Number.isNaN(capturedMs) || Number.isNaN(commitMs)) return false;
    return capturedMs >= commitMs - BASELINE_CAPTURE_WINDOW_MS && capturedMs <= commitMs;
  }

  private async buildWeeklyRecap(accountId: string, commitAt: string): Promise<string | null> {
    const commitDate = new Date(commitAt);
    if (Number.isNaN(commitDate.getTime())) return null;

    const currentWeekStart = this.startOfIsoWeek(commitDate);
    const nextWeekStart = new Date(currentWeekStart.getTime() + ONE_WEEK_MS);
    const currentWeekCommits = await this.countCommitsBetween(accountId, currentWeekStart, nextWeekStart);
    if (currentWeekCommits !== 1) return null;

    const lastWeekStart = new Date(currentWeekStart.getTime() - ONE_WEEK_MS);
    const priorWeekStart = new Date(lastWeekStart.getTime() - ONE_WEEK_MS);

    const [lastWeekDecisionCount, weeklyRows] = await Promise.all([
      this.countCommitsBetween(accountId, lastWeekStart, currentWeekStart),
      this.getSuccessfulDeltasBetween(accountId, priorWeekStart, currentWeekStart),
    ]);

    const priorWeekRows = weeklyRows.filter((row) => {
      const recordedAt = row.recorded_at_ms;
      return recordedAt >= priorWeekStart.getTime() && recordedAt < lastWeekStart.getTime();
    });
    const lastWeekRows = weeklyRows.filter((row) => {
      const recordedAt = row.recorded_at_ms;
      return recordedAt >= lastWeekStart.getTime() && recordedAt < currentWeekStart.getTime();
    });

    const priorWeekMedian = this.median(priorWeekRows.map((row) => row.delta_seconds));
    const lastWeekMedian = this.median(lastWeekRows.map((row) => row.delta_seconds));
    if (priorWeekMedian <= 0 || lastWeekMedian <= 0) return null;

    const deltaPct = Number((((lastWeekMedian - priorWeekMedian) / priorWeekMedian) * 100).toFixed(2));
    if (Math.abs(deltaPct) < 5) return null;

    const fasterOrSlower = deltaPct <= 0 ? 'faster' : 'slower';

    return `Last week: ${lastWeekDecisionCount} decisions, time-to-success ${this.formatNumber(Math.abs(deltaPct))}% ${fasterOrSlower} vs prior week.`;
  }

  private async countCommitsBetween(accountId: string, start: Date, end: Date): Promise<number> {
    const row = await this.db
      .prepare(`
        SELECT COUNT(*) AS c
        FROM decisions
        WHERE account_id = ?
          AND outcome_recorded_at IS NOT NULL
          AND outcome_recorded_at >= ?
          AND outcome_recorded_at < ?
      `)
      .bind(accountId, start.toISOString(), end.toISOString())
      .first<{ c: number }>();

    return row?.c || 0;
  }

  private async getSuccessfulDeltasBetween(accountId: string, start: Date, end: Date): Promise<WeeklyDeltaRow[]> {
    const rows = await this.db
      .prepare(`
        SELECT
          CAST((julianday(outcome_recorded_at) - julianday(created_at)) * 86400 AS INTEGER) AS delta_seconds,
          outcome_recorded_at
        FROM decisions
        WHERE account_id = ?
          AND outcome_success = 1
          AND outcome_recorded_at IS NOT NULL
          AND created_at IS NOT NULL
          AND outcome_recorded_at >= ?
          AND outcome_recorded_at < ?
      `)
      .bind(accountId, start.toISOString(), end.toISOString())
      .all<{ delta_seconds: number; outcome_recorded_at: string }>();

    return (rows.results || [])
      .map((row) => ({
        delta_seconds: Number(row.delta_seconds || 0),
        recorded_at_ms: Date.parse(String(row.outcome_recorded_at)),
      }))
      .filter((row) => !Number.isNaN(row.recorded_at_ms) && row.delta_seconds > 0);
  }

  private median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || 0;
  }

  private startOfIsoWeek(date: Date): Date {
    const start = new Date(date);
    start.setUTCHours(0, 0, 0, 0);
    const day = start.getUTCDay() || 7;
    start.setUTCDate(start.getUTCDate() - (day - 1));
    return start;
  }

  private formatNumber(value: number): string {
    return Number(value.toFixed(2)).toString();
  }
}
