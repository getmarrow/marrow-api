import { BaselineService } from './baseline.service';
import { ImpactService } from './impact.service';

const DEFAULT_PERIOD_DAYS = 7;
const MAX_PERIOD_DAYS = 90;
const MAX_DECISIONS_SCANNED = 500;
const AGENT_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface DecisionReportRow {
  decision_type: string;
  outcome_success: number | null;
  outcome_recorded_at: string | null;
  agent_id: string | null;
  session_id: string | null;
  created_at: string;
}

interface CountBucket {
  total: number;
  successful: number;
  failed: number;
}

export interface ValueReportOptions {
  periodDays?: number;
  agentId?: string | null;
}

export interface ValueReport {
  period: {
    days: number;
    start: string;
    end: string;
  };
  scope: {
    agent_id: string | null;
  };
  summary: string;
  metrics: {
    decisions: {
      total: number;
      recorded: number;
      successful: number;
      failed: number;
    };
    success_rate: number;
    saves: {
      period: number;
      total: number;
    };
  };
  fleet: {
    active_agents: number;
    top_agents: Array<{ agent_id: string; decisions: number; success_rate: number }>;
  };
  risks: {
    top_failure_types: Array<{ decision_type: string; failures: number; failure_rate: number }>;
  };
  recommendations: string[];
  improvement: Record<string, unknown>;
}

export class ValueReportService {
  constructor(private db: D1Database) {}

  async build(accountId: string, options: ValueReportOptions = {}): Promise<ValueReport> {
    const days = this.clampPeriod(options.periodDays);
    const agentId = this.sanitizeAgentId(options.agentId || null);
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const startIso = start.toISOString();

    const [rows, saves, improvement] = await Promise.all([
      this.getDecisionRows(accountId, startIso, agentId),
      new ImpactService(this.db).getSavesCount(accountId, startIso),
      new BaselineService(this.db).getAccountImprovement(accountId).catch(() => ({ status: 'unavailable' })),
    ]);

    const decisionStats = this.countDecisions(rows);
    const successRate = decisionStats.recorded > 0 ? decisionStats.successful / decisionStats.recorded : 0;
    const topAgents = this.topAgents(rows);
    const topFailureTypes = this.topFailureTypes(rows);
    const recommendations = this.buildRecommendations({ decisionStats, successRate, topFailureTypes, savesPeriod: saves.thisWeek });

    return {
      period: {
        days,
        start: startIso,
        end: end.toISOString(),
      },
      scope: {
        agent_id: agentId,
      },
      summary: this.buildSummary({
        days,
        agentId,
        decisionStats,
        successRate,
        savesPeriod: saves.thisWeek,
        topFailureTypes,
      }),
      metrics: {
        decisions: decisionStats,
        success_rate: this.round(successRate),
        saves: {
          period: saves.thisWeek,
          total: saves.total,
        },
      },
      fleet: {
        active_agents: topAgents.length,
        top_agents: topAgents,
      },
      risks: {
        top_failure_types: topFailureTypes,
      },
      recommendations,
      improvement: improvement as Record<string, unknown>,
    };
  }

  private async getDecisionRows(accountId: string, startIso: string, agentId: string | null): Promise<DecisionReportRow[]> {
    if (agentId) {
      const rows = await this.db.prepare(`
        SELECT decision_type, outcome_success, outcome_recorded_at, agent_id, session_id, created_at
        FROM decisions
        WHERE account_id = ? AND created_at > ? AND (agent_id = ? OR session_id = ?)
        ORDER BY created_at DESC
        LIMIT ?
      `).bind(accountId, startIso, agentId, agentId, MAX_DECISIONS_SCANNED).all<DecisionReportRow>();
      return rows.results || [];
    }

    const rows = await this.db.prepare(`
      SELECT decision_type, outcome_success, outcome_recorded_at, agent_id, session_id, created_at
      FROM decisions
      WHERE account_id = ? AND created_at > ?
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(accountId, startIso, MAX_DECISIONS_SCANNED).all<DecisionReportRow>();
    return rows.results || [];
  }

  private countDecisions(rows: DecisionReportRow[]): CountBucket & { recorded: number } {
    const stats = { total: rows.length, recorded: 0, successful: 0, failed: 0 };
    for (const row of rows) {
      if (row.outcome_success === null || row.outcome_success === undefined) continue;
      stats.recorded += 1;
      if (Number(row.outcome_success) === 1) stats.successful += 1;
      if (Number(row.outcome_success) === 0) stats.failed += 1;
    }
    return stats;
  }

  private topAgents(rows: DecisionReportRow[]): Array<{ agent_id: string; decisions: number; success_rate: number }> {
    const byAgent = new Map<string, CountBucket>();
    for (const row of rows) {
      const agentKey = String(row.agent_id || row.session_id || 'unknown');
      const bucket = byAgent.get(agentKey) || { total: 0, successful: 0, failed: 0 };
      bucket.total += 1;
      if (Number(row.outcome_success) === 1) bucket.successful += 1;
      if (Number(row.outcome_success) === 0) bucket.failed += 1;
      byAgent.set(agentKey, bucket);
    }

    return [...byAgent.entries()]
      .map(([agent_id, bucket]) => ({
        agent_id,
        decisions: bucket.total,
        success_rate: this.round((bucket.successful + bucket.failed) > 0 ? bucket.successful / (bucket.successful + bucket.failed) : 0),
      }))
      .sort((a, b) => b.decisions - a.decisions)
      .slice(0, 5);
  }

  private topFailureTypes(rows: DecisionReportRow[]): Array<{ decision_type: string; failures: number; failure_rate: number }> {
    const byType = new Map<string, CountBucket>();
    for (const row of rows) {
      const type = String(row.decision_type || 'unknown').slice(0, 80);
      const bucket = byType.get(type) || { total: 0, successful: 0, failed: 0 };
      if (row.outcome_success !== null && row.outcome_success !== undefined) {
        bucket.total += 1;
        if (Number(row.outcome_success) === 1) bucket.successful += 1;
        if (Number(row.outcome_success) === 0) bucket.failed += 1;
      }
      byType.set(type, bucket);
    }

    return [...byType.entries()]
      .filter(([, bucket]) => bucket.failed > 0)
      .map(([decision_type, bucket]) => ({
        decision_type,
        failures: bucket.failed,
        failure_rate: this.round(bucket.total > 0 ? bucket.failed / bucket.total : 0),
      }))
      .sort((a, b) => b.failures - a.failures)
      .slice(0, 5);
  }

  private buildSummary(input: {
    days: number;
    agentId: string | null;
    decisionStats: CountBucket & { recorded: number };
    successRate: number;
    savesPeriod: number;
    topFailureTypes: Array<{ decision_type: string; failures: number; failure_rate: number }>;
  }): string {
    const subject = input.agentId ? `Agent ${input.agentId}` : 'Your agent fleet';
    const successPct = Math.round(input.successRate * 100);
    const riskClause = input.topFailureTypes.length > 0
      ? `Top risk area: ${input.topFailureTypes[0].decision_type} (${input.topFailureTypes[0].failures} failures).`
      : 'No repeated failure category stands out in this period.';
    return `${subject} made ${input.decisionStats.total} decisions over ${input.days} days with ${successPct}% recorded success. Marrow confirmed ${input.savesPeriod} known failure${input.savesPeriod === 1 ? '' : 's'} avoided. ${riskClause}`;
  }

  private buildRecommendations(input: {
    decisionStats: CountBucket & { recorded: number };
    successRate: number;
    topFailureTypes: Array<{ decision_type: string; failures: number; failure_rate: number }>;
    savesPeriod: number;
  }): string[] {
    const recommendations: string[] = [];
    if (input.decisionStats.recorded < Math.max(3, Math.floor(input.decisionStats.total * 0.5))) {
      recommendations.push('Increase outcome commits so Marrow can measure agent improvement more accurately.');
    }
    if (input.topFailureTypes.length > 0) {
      recommendations.push(`Add a policy gate or checklist for ${input.topFailureTypes[0].decision_type} work.`);
    }
    if (input.successRate < 0.7 && input.decisionStats.recorded >= 3) {
      recommendations.push('Review recent failed decision types before allowing autonomous execution.');
    }
    if (input.savesPeriod === 0) {
      recommendations.push('Run agents through the safety loop before high-risk work so Marrow can prevent repeated failures.');
    }
    if (recommendations.length === 0) {
      recommendations.push('Keep using the safety loop and review value reports after each major workflow.');
    }
    return recommendations.slice(0, 4);
  }

  private clampPeriod(value: unknown): number {
    const parsed = Number(value || DEFAULT_PERIOD_DAYS);
    if (!Number.isFinite(parsed)) return DEFAULT_PERIOD_DAYS;
    return Math.min(MAX_PERIOD_DAYS, Math.max(1, Math.floor(parsed)));
  }

  private sanitizeAgentId(value: string | null): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!AGENT_ID_REGEX.test(trimmed)) return null;
    return trimmed;
  }

  private round(value: number): number {
    return Math.round(value * 1000) / 1000;
  }
}
