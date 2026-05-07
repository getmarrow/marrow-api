import { BaselineService } from './baseline.service';
import { ImpactService } from './impact.service';

const DEFAULT_PERIOD_DAYS = 7;
const MAX_PERIOD_DAYS = 90;
const MAX_DECISIONS_SCANNED = 500;
const AGENT_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SURFACE_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ACTION_MAX_LENGTH = 500;

export class ValueReportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueReportInputError';
  }
}

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

export type DecisionBriefRole = 'deploy' | 'audit' | 'patch' | 'review' | 'general';
export type DecisionBriefRiskLevel = 'low' | 'medium' | 'high';

export interface DecisionBriefOptions extends ValueReportOptions {
  action?: string | null;
  type?: string | null;
  sessionId?: string | null;
  role?: string | null;
  surfaces?: unknown;
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

type AgentStatusState = 'inactive' | 'warming_up' | 'needs_outcomes' | 'learning' | 'proving_value';
type MeasurementRisk = 'low' | 'medium' | 'high';

export interface AgentStatusReport {
  period: {
    days: number;
    start: string;
    end: string;
  };
  scope: {
    agent_id: string | null;
  };
  active: boolean;
  state: AgentStatusState;
  summary: string;
  signals: {
    decisions_logged: number;
    outcomes_recorded: number;
    outcome_coverage: number;
    success_rate: number;
    saves: {
      period: number;
      total: number;
    };
    active_agents: number;
    first_decision_at: string | null;
    last_decision_at: string | null;
  };
  quality: {
    enough_signal: boolean;
    measurement_risk: MeasurementRisk;
  };
  proof: {
    recent_decision_count: number;
    last_decision_at: string | null;
    has_recent_outcomes: boolean;
    has_prevented_failures: boolean;
    raw_data_exposed: false;
  };
  next_actions: string[];
}

export interface DecisionBrief {
  period: {
    days: number;
    start: string;
    end: string;
  };
  scope: {
    agent_id: string | null;
    session_id: string | null;
    role: DecisionBriefRole;
  };
  summary: string;
  risk: {
    level: DecisionBriefRiskLevel;
    reasons: string[];
    similar_failures: Array<{ decision_type: string; failures: number; failure_rate: number }>;
  };
  workflow: {
    recommended: string;
    steps: string[];
    source: 'role_playbook' | 'risk_pattern' | 'general';
  };
  handoff: {
    required: boolean;
    checkpoint_markers: string[];
    stale_after_minutes: number;
  };
  freshness: {
    check_required: boolean;
    surfaces: string[];
    stale_context_warning: boolean;
  };
  quality: {
    minimum_checks: string[];
    outcome_required: boolean;
    score_floor: number;
  };
  role_playbook: {
    role: DecisionBriefRole;
    guidance: string[];
  };
  failure_alerts: Array<{ decision_type: string; message: string; severity: 'info' | 'warning' | 'critical' }>;
  proof_pack: {
    required: boolean;
    fields: string[];
  };
  source_of_truth: {
    required_surfaces: string[];
    docs_required: boolean;
  };
  fleet_reliability: {
    active_agents: number;
    outcome_coverage: number;
    measurement_risk: MeasurementRisk;
  };
  next_actions: string[];
}

export class ValueReportService {
  constructor(private db: D1Database) {}

  async build(accountId: string, options: ValueReportOptions = {}): Promise<ValueReport> {
    const days = this.clampPeriod(options.periodDays);
    const agentId = this.sanitizeAgentId(options.agentId || null);
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const startIso = start.toISOString();

    const baseline = new BaselineService(this.db);
    const [rows, saves, improvement] = await Promise.all([
      this.getDecisionRows(accountId, startIso, agentId),
      new ImpactService(this.db).getSavesCount(accountId, startIso, agentId),
      (agentId ? baseline.getAgentImprovement(accountId, agentId) : baseline.getAccountImprovement(accountId))
        .catch(() => ({ status: 'unavailable' })),
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

  async buildAgentStatus(accountId: string, options: ValueReportOptions = {}): Promise<AgentStatusReport> {
    const days = this.clampPeriod(options.periodDays);
    const agentId = this.sanitizeAgentId(options.agentId || null);
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const startIso = start.toISOString();

    const [rows, saves] = await Promise.all([
      this.getDecisionRows(accountId, startIso, agentId),
      new ImpactService(this.db).getSavesCount(accountId, startIso, agentId),
    ]);

    const decisionStats = this.countDecisions(rows);
    const successRate = decisionStats.recorded > 0 ? decisionStats.successful / decisionStats.recorded : 0;
    const outcomeCoverage = decisionStats.total > 0 ? decisionStats.recorded / decisionStats.total : 0;
    const state = this.agentStatusState(decisionStats, outcomeCoverage, saves.thisWeek);
    const measurementRisk = this.measurementRisk(decisionStats.total, outcomeCoverage);
    const activeAgentCount = this.activeAgentCount(rows);
    const decisionTimes = this.decisionTimes(rows);

    const report = {
      period: {
        days,
        start: startIso,
        end: end.toISOString(),
      },
      scope: {
        agent_id: agentId,
      },
      active: decisionStats.total > 0,
      state,
      summary: this.buildAgentStatusSummary({
        days,
        agentId,
        state,
        decisionsLogged: decisionStats.total,
        outcomeCoverage,
        savesPeriod: saves.thisWeek,
      }),
      signals: {
        decisions_logged: decisionStats.total,
        outcomes_recorded: decisionStats.recorded,
        outcome_coverage: this.round(outcomeCoverage),
        success_rate: this.round(successRate),
        saves: {
          period: saves.thisWeek,
          total: saves.total,
        },
        active_agents: activeAgentCount,
        first_decision_at: decisionTimes.first,
        last_decision_at: decisionTimes.last,
      },
      quality: {
        enough_signal: decisionStats.recorded >= 3 && outcomeCoverage >= 0.5,
        measurement_risk: measurementRisk,
      },
      proof: {
        recent_decision_count: decisionStats.total,
        last_decision_at: decisionTimes.last,
        has_recent_outcomes: decisionStats.recorded > 0,
        has_prevented_failures: saves.thisWeek > 0,
        raw_data_exposed: false as const,
      },
      next_actions: this.buildAgentStatusNextActions({
        state,
        decisionStats,
        outcomeCoverage,
        savesPeriod: saves.thisWeek,
      }),
    };

    return report;
  }

  async buildDecisionBrief(accountId: string, options: DecisionBriefOptions = {}): Promise<DecisionBrief> {
    const days = this.clampPeriod(options.periodDays);
    const agentId = this.sanitizeAgentId(options.agentId || null);
    const sessionId = this.sanitizeSessionId(options.sessionId || null);
    const role = this.normalizeRole(options.role || options.type || null);
    const action = this.sanitizeAction(options.action || '');
    if (!action) throw new ValueReportInputError('action is required');
    const type = this.sanitizeDecisionType(options.type || '');
    const requestedSurfaces = this.sanitizeSurfaces(options.surfaces);
    const surfaces = requestedSurfaces.length > 0 ? requestedSurfaces : this.inferSurfaces(action, type, role);
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const startIso = start.toISOString();

    const scopedId = agentId || sessionId;
    const [rows, saves] = await Promise.all([
      this.getDecisionRows(accountId, startIso, scopedId),
      new ImpactService(this.db).getSavesCount(accountId, startIso, scopedId),
    ]);

    const decisionStats = this.countDecisions(rows);
    const outcomeCoverage = decisionStats.total > 0 ? decisionStats.recorded / decisionStats.total : 0;
    const measurementRisk = this.measurementRisk(decisionStats.total, outcomeCoverage);
    const topFailureTypes = this.topFailureTypes(rows);
    const riskReasons = this.riskReasons({ action, type, role, surfaces, topFailureTypes, measurementRisk });
    const riskLevel = this.riskLevel(riskReasons, topFailureTypes);
    const workflow = this.workflowFor(role, riskLevel, surfaces);
    const minimumChecks = this.minimumChecks(role, riskLevel, surfaces);
    const handoffRequired = riskLevel === 'high' || ['deploy', 'audit', 'patch', 'review'].includes(role);
    const proofFields = this.proofPackFields(surfaces, role, handoffRequired);
    const sourceSurfaces = this.sourceOfTruthSurfaces(surfaces, role);

    const brief: DecisionBrief = {
      period: {
        days,
        start: startIso,
        end: end.toISOString(),
      },
      scope: {
        agent_id: agentId,
        session_id: sessionId,
        role,
      },
      summary: this.decisionBriefSummary({ role, riskLevel, surfaces, topFailureTypes, measurementRisk }),
      risk: {
        level: riskLevel,
        reasons: riskReasons,
        similar_failures: topFailureTypes,
      },
      workflow,
      handoff: {
        required: handoffRequired,
        checkpoint_markers: this.checkpointMarkers(role),
        stale_after_minutes: riskLevel === 'high' ? 15 : 30,
      },
      freshness: {
        check_required: surfaces.length > 0 || riskLevel !== 'low',
        surfaces,
        stale_context_warning: measurementRisk !== 'low' || decisionStats.total === 0,
      },
      quality: {
        minimum_checks: minimumChecks,
        outcome_required: true,
        score_floor: riskLevel === 'high' ? 0.85 : riskLevel === 'medium' ? 0.7 : 0.55,
      },
      role_playbook: {
        role,
        guidance: this.roleGuidance(role, riskLevel),
      },
      failure_alerts: this.failureAlerts(topFailureTypes),
      proof_pack: {
        required: handoffRequired || surfaces.length > 0,
        fields: proofFields,
      },
      source_of_truth: {
        required_surfaces: sourceSurfaces,
        docs_required: sourceSurfaces.includes('docs'),
      },
      fleet_reliability: {
        active_agents: this.activeAgentCount(rows),
        outcome_coverage: this.round(outcomeCoverage),
        measurement_risk: measurementRisk,
      },
      next_actions: this.decisionBriefNextActions({
        riskLevel,
        role,
        surfaces,
        minimumChecks,
        savesPeriod: saves.thisWeek,
        topFailureTypes,
        measurementRisk,
      }),
    };

    return brief;
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

  private agentStatusState(
    decisionStats: CountBucket & { recorded: number },
    outcomeCoverage: number,
    savesPeriod: number,
  ): AgentStatusState {
    if (decisionStats.total === 0) return 'inactive';
    if (decisionStats.total < 3) return 'warming_up';
    if (outcomeCoverage < 0.5) return 'needs_outcomes';
    if (savesPeriod > 0 || decisionStats.recorded >= 5) return 'proving_value';
    return 'learning';
  }

  private measurementRisk(totalDecisions: number, outcomeCoverage: number): MeasurementRisk {
    if (totalDecisions === 0) return 'high';
    if (outcomeCoverage < 0.3) return 'high';
    if (outcomeCoverage < 0.7) return 'medium';
    return 'low';
  }

  private activeAgentCount(rows: DecisionReportRow[]): number {
    const agents = new Set<string>();
    for (const row of rows) {
      agents.add(String(row.agent_id || row.session_id || 'unknown'));
    }
    return agents.size;
  }

  private decisionTimes(rows: DecisionReportRow[]): { first: string | null; last: string | null } {
    if (rows.length === 0) return { first: null, last: null };
    return {
      first: rows[rows.length - 1].created_at,
      last: rows[0].created_at,
    };
  }

  private buildAgentStatusSummary(input: {
    days: number;
    agentId: string | null;
    state: AgentStatusState;
    decisionsLogged: number;
    outcomeCoverage: number;
    savesPeriod: number;
  }): string {
    const subject = input.agentId ? `Agent ${input.agentId}` : 'Your agent fleet';
    if (input.state === 'inactive') {
      return `${subject} has not logged Marrow decisions in the last ${input.days} days. Verify the SDK, MCP, or workflow hook is installed before relying on value claims.`;
    }
    const coveragePct = Math.round(input.outcomeCoverage * 100);
    return `${subject} is connected to Marrow with ${input.decisionsLogged} decisions logged over ${input.days} days, ${coveragePct}% outcome coverage, and ${input.savesPeriod} known failure${input.savesPeriod === 1 ? '' : 's'} avoided.`;
  }

  private buildAgentStatusNextActions(input: {
    state: AgentStatusState;
    decisionStats: CountBucket & { recorded: number };
    outcomeCoverage: number;
    savesPeriod: number;
  }): string[] {
    if (input.state === 'inactive') {
      return [
        'Verify the Marrow API key and agent identity are loaded.',
        'Log one decision through the SDK, MCP, or workflow endpoint.',
      ];
    }

    const actions: string[] = [];
    if (input.state === 'warming_up') {
      actions.push('Keep logging decisions until Marrow has enough signal to compare outcomes.');
    }
    if (input.outcomeCoverage < 0.5) {
      actions.push('Commit outcomes for recent decisions so Marrow can measure improvement.');
    }
    if (input.decisionStats.recorded >= 3 && input.decisionStats.failed > 0) {
      actions.push('Review failed decision categories before similar autonomous work.');
    }
    if (input.savesPeriod === 0) {
      actions.push('Run high-risk work through the safety loop so Marrow can prevent repeated failures.');
    }
    if (actions.length === 0) {
      actions.push('Continue using Marrow passively and pull value reports after major workflow batches.');
    }
    return actions.slice(0, 4);
  }

  private normalizeRole(value: string | null): DecisionBriefRole {
    const normalized = String(value || '').toLowerCase();
    if (/(deploy|publish|release|merge|production)/.test(normalized)) return 'deploy';
    if (/(audit|security|opsec|scan|harden)/.test(normalized)) return 'audit';
    if (/(patch|fix|backend|implementation|build)/.test(normalized)) return 'patch';
    if (/(review|final|verify|qa|smoke)/.test(normalized)) return 'review';
    return 'general';
  }

  private sanitizeAction(value: string): string {
    return String(value || '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, ACTION_MAX_LENGTH);
  }

  private sanitizeDecisionType(value: string): string {
    return String(value || '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 80).toLowerCase();
  }

  private sanitizeSessionId(value: string | null): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!SESSION_ID_REGEX.test(trimmed)) throw new ValueReportInputError('Invalid session_id');
    return trimmed;
  }

  private sanitizeSurfaces(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const surfaces: string[] = [];
    for (const item of value) {
      const normalized = String(item || '').trim().toLowerCase();
      if (!normalized) continue;
      if (!SURFACE_REGEX.test(normalized)) throw new ValueReportInputError('Invalid surface');
      if (!surfaces.includes(normalized)) surfaces.push(normalized);
    }
    return surfaces.slice(0, 12);
  }

  private inferSurfaces(action: string, type: string, role: DecisionBriefRole): string[] {
    const text = `${action} ${type} ${role}`.toLowerCase();
    const surfaces: string[] = [];
    const add = (surface: string) => { if (!surfaces.includes(surface)) surfaces.push(surface); };
    if (/(github|repo|branch|pr|merge|commit)/.test(text)) add('github');
    if (/(npm|package|publish|sdk|mcp)/.test(text)) add('npm');
    if (/(doc|readme|getmarrow\.ai)/.test(text)) add('docs');
    if (/(prod|production|deploy|cloudflare|worker|pages)/.test(text)) add('production');
    if (/(secret|token|key|auth|permission)/.test(text)) add('secrets');
    if (surfaces.length === 0 && role === 'deploy') return ['github', 'production'];
    return surfaces;
  }

  private riskReasons(input: {
    action: string;
    type: string;
    role: DecisionBriefRole;
    surfaces: string[];
    topFailureTypes: Array<{ decision_type: string; failures: number; failure_rate: number }>;
    measurementRisk: MeasurementRisk;
  }): string[] {
    const text = `${input.action} ${input.type} ${input.role}`.toLowerCase();
    const reasons: string[] = [];
    if (input.role === 'deploy') reasons.push('deploy_or_publish_work');
    if (/(prod|production|deploy|publish|merge|release|rollback)/.test(text)) reasons.push('external_or_production_change');
    if (/(secret|token|key|auth|permission|admin)/.test(text)) reasons.push('credential_or_permission_surface');
    if (input.surfaces.includes('npm')) reasons.push('package_registry_surface');
    if (input.surfaces.includes('docs')) reasons.push('source_of_truth_docs_surface');
    if (input.topFailureTypes.length > 0) reasons.push('similar_failure_history');
    if (input.measurementRisk === 'high') reasons.push('low_outcome_signal');
    if (reasons.length === 0) reasons.push('routine_logged_work');
    return [...new Set(reasons)].slice(0, 8);
  }

  private riskLevel(
    reasons: string[],
    topFailureTypes: Array<{ decision_type: string; failures: number; failure_rate: number }>,
  ): DecisionBriefRiskLevel {
    if (
      reasons.includes('external_or_production_change')
      || reasons.includes('credential_or_permission_surface')
      || topFailureTypes.some((failure) => failure.failure_rate >= 0.5 && failure.failures >= 2)
    ) {
      return 'high';
    }
    if (reasons.includes('deploy_or_publish_work') || reasons.includes('similar_failure_history') || reasons.includes('low_outcome_signal')) {
      return 'medium';
    }
    return 'low';
  }

  private workflowFor(role: DecisionBriefRole, riskLevel: DecisionBriefRiskLevel, surfaces: string[]): DecisionBrief['workflow'] {
    if (role === 'deploy') {
      return {
        recommended: 'safe-deploy-publish',
        source: 'role_playbook',
        steps: ['log intent', 'confirm branch and version', 'run tests/build', 'run dry-run', 'execute deploy or publish', 'verify live surfaces', 'record rollback target', 'commit result'],
      };
    }
    if (role === 'audit') {
      return {
        recommended: 'security-audit-harden',
        source: 'role_playbook',
        steps: ['log intent', 'scan dependencies and exposed surfaces', 'identify exploitability', 'write patch requirements', 'verify hardening', 'produce audit proof', 'commit result'],
      };
    }
    if (role === 'patch') {
      return {
        recommended: 'backend-patch-verify',
        source: 'role_playbook',
        steps: ['log intent', 'read failing report', 'patch smallest safe surface', 'run targeted tests', 'run regression checks', 'write changed files and residual risk', 'commit result'],
      };
    }
    if (role === 'review') {
      return {
        recommended: 'final-review-gate',
        source: 'role_playbook',
        steps: ['log intent', 'inspect diff', 'verify tests and security checks', 'check docs/source-of-truth', 'confirm rollback or blocker state', 'approve or block', 'commit result'],
      };
    }
    return {
      recommended: riskLevel === 'low' && surfaces.length === 0 ? 'standard-decision-loop' : 'guarded-decision-loop',
      source: riskLevel === 'low' ? 'general' : 'risk_pattern',
      steps: ['log intent', 'check prior failures', 'perform work', 'verify outcome', 'commit result'],
    };
  }

  private minimumChecks(role: DecisionBriefRole, riskLevel: DecisionBriefRiskLevel, surfaces: string[]): string[] {
    const checks = new Set<string>();
    checks.add('commit_outcome');
    if (['deploy', 'patch', 'review'].includes(role)) checks.add('tests_or_build');
    if (riskLevel !== 'low' || role === 'deploy') checks.add('dry_run_or_report_only');
    if (surfaces.includes('production')) checks.add('post_action_smoke');
    if (surfaces.includes('docs')) checks.add('live_docs_verify');
    if (surfaces.includes('npm')) checks.add('registry_version_verify');
    if (surfaces.includes('github')) checks.add('remote_branch_verify');
    if (role === 'audit') checks.add('security_audit');
    return [...checks];
  }

  private checkpointMarkers(role: DecisionBriefRole): string[] {
    const terminal = role === 'deploy' ? 'DEPLOY_DONE'
      : role === 'audit' ? 'AUDIT_DONE'
      : role === 'patch' ? 'PATCH_DONE'
      : role === 'review' ? 'REPORT_DONE'
      : 'REPORT_DONE';
    return ['STARTED', 'FILES_READ', 'CHECKS_DONE', terminal, 'FINAL'];
  }

  private proofPackFields(surfaces: string[], role: DecisionBriefRole, handoffRequired: boolean): string[] {
    const fields = new Set<string>(['summary', 'checks', 'outcome', 'blockers']);
    if (surfaces.includes('github')) fields.add('commits_prs_shas');
    if (surfaces.includes('npm')) fields.add('package_versions');
    if (surfaces.includes('docs')) fields.add('docs_urls_verified');
    if (surfaces.includes('production')) fields.add('deployment_and_smoke');
    if (role === 'deploy') fields.add('rollback_target');
    if (handoffRequired) fields.add('handoff_result_file');
    return [...fields];
  }

  private sourceOfTruthSurfaces(surfaces: string[], role: DecisionBriefRole): string[] {
    const required = new Set(surfaces);
    if (role === 'deploy') {
      required.add('github');
      required.add('production');
    }
    if (surfaces.includes('npm')) required.add('docs');
    return [...required];
  }

  private roleGuidance(role: DecisionBriefRole, riskLevel: DecisionBriefRiskLevel): string[] {
    const common = riskLevel === 'high' ? ['Do not proceed without a reversible path or explicit blocker report.'] : [];
    const byRole: Record<DecisionBriefRole, string[]> = {
      deploy: ['Dry-run before mutation.', 'Verify every public surface after deploy or publish.', 'Record rollback target.'],
      audit: ['Report exploitability and hardening priority.', 'Do not patch silently; hand off precise requirements.'],
      patch: ['Keep patch scope narrow.', 'Run tests that prove the reported issue is closed.'],
      review: ['Lead with blockers and residual risk.', 'Confirm docs, production, and package surfaces match the code.'],
      general: ['Use Marrow before meaningful action and commit the outcome after verification.'],
    };
    return [...common, ...byRole[role]].slice(0, 5);
  }

  private failureAlerts(topFailureTypes: Array<{ decision_type: string; failures: number; failure_rate: number }>): DecisionBrief['failure_alerts'] {
    return topFailureTypes.slice(0, 3).map((failure) => ({
      decision_type: failure.decision_type,
      severity: failure.failure_rate >= 0.5 ? 'critical' as const : 'warning' as const,
      message: `${failure.decision_type} has ${failure.failures} recorded failure${failure.failures === 1 ? '' : 's'} in this period. Reuse a guarded workflow before similar work.`,
    }));
  }

  private decisionBriefSummary(input: {
    role: DecisionBriefRole;
    riskLevel: DecisionBriefRiskLevel;
    surfaces: string[];
    topFailureTypes: Array<{ decision_type: string; failures: number; failure_rate: number }>;
    measurementRisk: MeasurementRisk;
  }): string {
    const surfaceText = input.surfaces.length > 0 ? ` across ${input.surfaces.join(', ')}` : '';
    const failureText = input.topFailureTypes.length > 0
      ? ` Prior failures exist for ${input.topFailureTypes[0].decision_type}.`
      : '';
    const signalText = input.measurementRisk === 'high'
      ? ' Outcome history is thin, so verify more aggressively.'
      : '';
    return `${input.riskLevel.toUpperCase()} risk ${input.role} work${surfaceText}. Use the recommended playbook before acting.${failureText}${signalText}`;
  }

  private decisionBriefNextActions(input: {
    riskLevel: DecisionBriefRiskLevel;
    role: DecisionBriefRole;
    surfaces: string[];
    minimumChecks: string[];
    savesPeriod: number;
    topFailureTypes: Array<{ decision_type: string; failures: number; failure_rate: number }>;
    measurementRisk: MeasurementRisk;
  }): string[] {
    const actions: string[] = [];
    if (input.riskLevel === 'high') actions.push('Run a dry-run or report-only pass before mutating production, GitHub, npm, or secrets.');
    if (input.surfaces.includes('docs')) actions.push('Verify live docs after the change, not just the repo source.');
    if (input.surfaces.includes('npm')) actions.push('Verify npm registry versions after publish.');
    if (input.surfaces.includes('github')) actions.push('Verify default branch and remote HEAD after merge or branch-setting changes.');
    if (input.topFailureTypes.length > 0) actions.push(`Review the ${input.topFailureTypes[0].decision_type} failure pattern before proceeding.`);
    if (input.measurementRisk !== 'low') actions.push('Commit outcomes for this work so future agents can trust Marrow guidance.');
    if (input.savesPeriod === 0 && input.role === 'deploy') actions.push('Use the safety loop so Marrow can record prevented failures when warnings are acted on.');
    if (actions.length === 0) actions.push('Proceed with the standard Marrow think/act/commit loop and record verification evidence.');
    return actions.slice(0, 6);
  }

  private clampPeriod(value: unknown): number {
    const parsed = Number(value || DEFAULT_PERIOD_DAYS);
    if (!Number.isFinite(parsed)) return DEFAULT_PERIOD_DAYS;
    return Math.min(MAX_PERIOD_DAYS, Math.max(1, Math.floor(parsed)));
  }

  private sanitizeAgentId(value: string | null): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!AGENT_ID_REGEX.test(trimmed)) throw new ValueReportInputError('Invalid agent_id');
    return trimmed;
  }

  private round(value: number): number {
    return Math.round(value * 1000) / 1000;
  }
}
