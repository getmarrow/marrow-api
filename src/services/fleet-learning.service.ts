import { now, uuid } from '../utils/crypto';

type LessonType = 'success' | 'failure' | 'deploy' | 'incident' | 'handoff' | 'general';
type LessonVisibility = 'private' | 'shared' | 'production-critical';
type HandoffStatus = 'pending' | 'accepted' | 'working' | 'blocked' | 'complete' | 'stale' | 'cancelled';
type DeploymentStatus = 'planned' | 'dry_run' | 'deployed' | 'verified' | 'rolled_back' | 'incident';
type MemoryPermission = 'read-only' | 'contribute-only' | 'private' | 'shared' | 'production-critical';

interface DecisionOutcomeRow {
  id: string;
  decision_type: string;
  context: string | null;
  outcome: string | null;
  confidence: number | null;
  outcome_success: number | null;
  agent_id: string | null;
  session_id: string | null;
  created_at: string;
}

interface LessonRow {
  id: string;
  source_decision_id: string | null;
  agent_id: string | null;
  lesson_type: LessonType;
  title: string;
  summary: string;
  action_pattern: string | null;
  outcome_success: number | null;
  confidence: number;
  score: number;
  reuse_count: number;
  visibility: LessonVisibility;
  tags: string | null;
  created_at: string;
  updated_at: string;
  last_reused_at: string | null;
}

interface DeploymentMemoryRow {
  id: string;
  agent_id: string | null;
  workflow_id: string | null;
  release_id: string | null;
  pr_url: string | null;
  commit_sha: string | null;
  environment: string;
  status: DeploymentStatus;
  tests: string | null;
  smoke_result: string | null;
  rollback_plan: string | null;
  prod_health: string | null;
  incident_summary: string | null;
  created_at: string;
  updated_at: string;
}

interface HandoffRow {
  id: string;
  workflow_id: string | null;
  from_agent_id: string | null;
  to_agent_id: string;
  task: string;
  status: HandoffStatus;
  checkpoint: string | null;
  result_summary: string | null;
  stale_after_seconds: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface PermissionRow {
  id: string;
  agent_id: string;
  scope: string;
  permission: MemoryPermission;
  resource_type: string;
  resource_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RiskGateProofRow {
  action: string;
  risk_level: string;
  decision: string;
  allow: number;
  agent_id: string | null;
  session_id: string | null;
  created_at: string;
}

export interface FleetLesson {
  id: string;
  source_decision_id: string | null;
  agent_id: string | null;
  lesson_type: LessonType;
  title: string;
  summary: string;
  action_pattern: string | null;
  outcome_success: boolean | null;
  confidence: number;
  score: number;
  reuse_count: number;
  visibility: LessonVisibility;
  tags: string[];
  created_at: string;
  updated_at: string;
  last_reused_at: string | null;
}

export interface DeploymentMemory {
  id: string;
  agent_id: string | null;
  workflow_id: string | null;
  release_id: string | null;
  pr_url: string | null;
  commit_sha: string | null;
  environment: string;
  status: DeploymentStatus;
  tests: string[];
  smoke_result: string | null;
  rollback_plan: string | null;
  prod_health: string | null;
  incident_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentHandoff {
  id: string;
  workflow_id: string | null;
  from_agent_id: string | null;
  to_agent_id: string;
  task: string;
  status: HandoffStatus;
  checkpoint: string | null;
  result_summary: string | null;
  stale_after_seconds: number;
  stale: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export class FleetLearningService {
  constructor(private db: D1Database) {}

  async recordLesson(accountId: string, input: {
    source_decision_id?: string | null;
    agent_id?: string | null;
    lesson_type?: string | null;
    title?: string | null;
    summary: string;
    action_pattern?: string | null;
    outcome_success?: boolean | null;
    confidence?: number | null;
    visibility?: string | null;
    tags?: unknown;
  }): Promise<FleetLesson> {
    const ts = now();
    const lessonType = this.normalizeLessonType(input.lesson_type, input.outcome_success);
    const confidence = this.clampNumber(input.confidence, 0.5, 0, 1);
    const score = this.scoreLesson(input.outcome_success ?? null, confidence, 0, ts);
    const id = uuid();
    const tags = this.sanitizeTags(input.tags);
    const title = this.sanitizeText(input.title || this.titleFromSummary(input.summary), 140);
    const summary = this.sanitizeText(input.summary, 1000);
    if (!summary) throw new Error('summary is required');

    await this.db.prepare(`
      INSERT INTO fleet_lessons
        (id, account_id, source_decision_id, agent_id, lesson_type, title, summary,
         action_pattern, outcome_success, confidence, score, reuse_count, visibility,
         tags, created_at, updated_at, last_reused_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      accountId,
      this.sanitizeOptional(input.source_decision_id, 128),
      this.sanitizeOptional(input.agent_id, 128),
      lessonType,
      title,
      summary,
      this.sanitizeOptional(input.action_pattern, 500),
      input.outcome_success === true ? 1 : input.outcome_success === false ? 0 : null,
      confidence,
      score,
      0,
      this.normalizeVisibility(input.visibility),
      JSON.stringify(tags),
      ts,
      ts,
      null,
    ).run();

    const lesson = await this.getLesson(accountId, id);
    if (!lesson) throw new Error('Failed to create lesson');
    return lesson;
  }

  async learnFromDecision(accountId: string, decisionId: string, accessAgentIds?: string[] | null): Promise<FleetLesson | null> {
    const row = await this.db.prepare(`
      SELECT id, decision_type, context, outcome, confidence, outcome_success, agent_id, session_id, created_at
      FROM decisions
      WHERE account_id = ? AND id = ?
      LIMIT 1
    `).bind(accountId, decisionId).first<DecisionOutcomeRow>();

    if (!row || row.outcome_success === null || row.outcome_success === undefined) return null;
    if (!this.canAccessAgentRow(row.agent_id || row.session_id, accessAgentIds || null)) return null;

    const existing = await this.db.prepare(`
      SELECT id FROM fleet_lessons
      WHERE account_id = ? AND source_decision_id = ?
      LIMIT 1
    `).bind(accountId, decisionId).first<{ id: string }>();
    if (existing?.id) {
      const lesson = await this.getLesson(accountId, existing.id);
      return lesson && this.canAccessLesson(lesson, accessAgentIds || null) ? lesson : null;
    }

    const success = Number(row.outcome_success) === 1;
    const decisionType = this.sanitizeText(row.decision_type || 'decision', 80) || 'decision';
    return this.recordLesson(accountId, {
      source_decision_id: row.id,
      agent_id: row.agent_id || row.session_id,
      lesson_type: success ? 'success' : 'failure',
      title: `${success ? 'Reuse' : 'Review'} ${decisionType} pattern`,
      summary: success
        ? `Successful ${decisionType} outcome recorded. Reuse this pattern only after matching checks pass.`
        : `Failed ${decisionType} outcome recorded. Review this pattern before similar work.`,
      action_pattern: decisionType,
      outcome_success: success,
      confidence: row.confidence,
      visibility: 'private',
      tags: [decisionType, success ? 'worked' : 'failed', 'auto-learned'],
    });
  }

  async listLessons(accountId: string, filters: {
    query?: string | null;
    lesson_type?: string | null;
    agent_id?: string | null;
    access_agent_ids?: string[] | null;
    limit?: number | null;
  } = {}): Promise<FleetLesson[]> {
    const limit = this.clampInt(filters.limit, 10, 50);
    const rows = await this.db.prepare(`
      SELECT id, source_decision_id, agent_id, lesson_type, title, summary, action_pattern,
             outcome_success, confidence, score, reuse_count, visibility, tags,
             created_at, updated_at, last_reused_at
      FROM fleet_lessons
      WHERE account_id = ?
      ORDER BY score DESC
      LIMIT ?
    `).bind(accountId, limit * 3).all<LessonRow>();

    const query = this.sanitizeOptional(filters.query, 160)?.toLowerCase() || '';
    const queryTokens = query.split(/\s+/).filter((token) => token.length >= 3).slice(0, 6);
    const type = this.normalizeLessonTypeFilter(filters.lesson_type);
    const agentId = this.sanitizeOptional(filters.agent_id, 128);

    return (rows.results || [])
      .filter((row) => !type || row.lesson_type === type)
      .filter((row) => !agentId || row.agent_id === agentId)
      .filter((row) => this.canAccessLesson(row, filters.access_agent_ids || null))
      .filter((row) => {
        if (!query) return true;
        const haystack = `${row.title} ${row.summary} ${row.action_pattern || ''}`.toLowerCase();
        return haystack.includes(query) || queryTokens.some((token) => haystack.includes(token));
      })
      .slice(0, limit)
      .map((row) => this.toLesson(row));
  }

  async markLessonReused(accountId: string, lessonId: string, accessAgentIds?: string[] | null): Promise<FleetLesson | null> {
    const ts = now();
    const lesson = await this.getLesson(accountId, lessonId);
    if (!lesson) return null;
    if (!this.canAccessLesson(lesson, accessAgentIds || null)) return null;
    const nextReuseCount = lesson.reuse_count + 1;
    const nextScore = Math.min(1, lesson.score + 0.03);
    await this.db.prepare(`
      UPDATE fleet_lessons
      SET reuse_count = ?, score = ?, last_reused_at = ?, updated_at = ?
      WHERE account_id = ? AND id = ?
    `).bind(nextReuseCount, nextScore, ts, ts, accountId, lessonId).run();
    return this.getLesson(accountId, lessonId);
  }

  async recordRiskGate(accountId: string, input: {
    agent_id?: string | null;
    session_id?: string | null;
    action: string;
    risk_level: string;
    decision: string;
    allow: boolean;
    reasons?: unknown;
    policy?: unknown;
  }): Promise<{ id: string; created_at: string }> {
    const id = uuid();
    const ts = now();
    await this.db.prepare(`
      INSERT INTO risk_gate_events
        (id, account_id, agent_id, session_id, action, risk_level, decision, allow, reasons, policy, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      accountId,
      this.sanitizeOptional(input.agent_id, 128),
      this.sanitizeOptional(input.session_id, 128),
      this.sanitizeText(input.action, 500),
      this.safeChoice(input.risk_level, ['low', 'medium', 'high'], 'low'),
      this.safeChoice(input.decision, ['allow', 'warn', 'review_required', 'block'], 'allow'),
      input.allow ? 1 : 0,
      this.safeJson(input.reasons, []),
      this.safeJson(input.policy, {}),
      ts,
    ).run();
    return { id, created_at: ts };
  }

  async recordDeploymentMemory(accountId: string, input: {
    agent_id?: string | null;
    workflow_id?: string | null;
    release_id?: string | null;
    pr_url?: string | null;
    commit_sha?: string | null;
    environment?: string | null;
    status?: string | null;
    tests?: unknown;
    smoke_result?: string | null;
    rollback_plan?: string | null;
    prod_health?: string | null;
    incident_summary?: string | null;
  }): Promise<DeploymentMemory> {
    const id = uuid();
    const ts = now();
    await this.db.prepare(`
      INSERT INTO deployment_memories
        (id, account_id, agent_id, workflow_id, release_id, pr_url, commit_sha,
         environment, status, tests, smoke_result, rollback_plan, prod_health,
         incident_summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      accountId,
      this.sanitizeOptional(input.agent_id, 128),
      this.sanitizeOptional(input.workflow_id, 128),
      this.sanitizeOptional(input.release_id, 160),
      this.sanitizeUrl(input.pr_url),
      this.sanitizeOptional(input.commit_sha, 80),
      this.sanitizeText(input.environment || 'production', 80) || 'production',
      this.safeChoice(input.status, ['planned', 'dry_run', 'deployed', 'verified', 'rolled_back', 'incident'], 'planned'),
      JSON.stringify(this.sanitizeStringArray(input.tests, 20, 160)),
      this.sanitizeOptional(input.smoke_result, 500),
      this.sanitizeOptional(input.rollback_plan, 1000),
      this.sanitizeOptional(input.prod_health, 500),
      this.sanitizeOptional(input.incident_summary, 1000),
      ts,
      ts,
    ).run();

    const memory = await this.getDeploymentMemory(accountId, id);
    if (!memory) throw new Error('Failed to create deployment memory');
    return memory;
  }

  async listDeploymentMemories(accountId: string, filters: { environment?: string | null; status?: string | null; agent_id?: string | null; access_agent_ids?: string[] | null; limit?: number | null } = {}): Promise<DeploymentMemory[]> {
    const rows = await this.db.prepare(`
      SELECT id, agent_id, workflow_id, release_id, pr_url, commit_sha, environment, status, tests,
             smoke_result, rollback_plan, prod_health, incident_summary, created_at, updated_at
      FROM deployment_memories
      WHERE account_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(accountId, this.clampInt(filters.limit, 10, 50) * 2).all<DeploymentMemoryRow>();
    const environment = this.sanitizeOptional(filters.environment, 80);
    const status = this.safeOptionalChoice(filters.status, ['planned', 'dry_run', 'deployed', 'verified', 'rolled_back', 'incident']);
    const agentId = this.sanitizeOptional(filters.agent_id, 128);
    return (rows.results || [])
      .filter((row) => !environment || row.environment === environment)
      .filter((row) => !status || row.status === status)
      .filter((row) => !agentId || row.agent_id === agentId)
      .filter((row) => this.canAccessAgentRow(row.agent_id, filters.access_agent_ids || null))
      .slice(0, this.clampInt(filters.limit, 10, 50))
      .map((row) => this.toDeploymentMemory(row));
  }

  async createHandoff(accountId: string, input: {
    workflow_id?: string | null;
    from_agent_id?: string | null;
    to_agent_id: string;
    task: string;
    checkpoint?: string | null;
    stale_after_seconds?: number | null;
  }): Promise<AgentHandoff> {
    const id = uuid();
    const ts = now();
    const toAgentId = this.sanitizeText(input.to_agent_id, 128);
    const task = this.sanitizeText(input.task, 1000);
    if (!toAgentId) throw new Error('to_agent_id is required');
    if (!task) throw new Error('task is required');
    await this.db.prepare(`
      INSERT INTO agent_handoffs
        (id, account_id, workflow_id, from_agent_id, to_agent_id, task, status,
         checkpoint, result_summary, stale_after_seconds, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      accountId,
      this.sanitizeOptional(input.workflow_id, 128),
      this.sanitizeOptional(input.from_agent_id, 128),
      toAgentId,
      task,
      'pending',
      this.sanitizeOptional(input.checkpoint, 1000),
      null,
      this.clampInt(input.stale_after_seconds, 1800, 86400),
      ts,
      ts,
      null,
    ).run();
    const handoff = await this.getHandoff(accountId, id);
    if (!handoff) throw new Error('Failed to create handoff');
    return handoff;
  }

  async updateHandoff(accountId: string, handoffId: string, patch: {
    status?: string | null;
    checkpoint?: string | null;
    result_summary?: string | null;
  }): Promise<AgentHandoff | null> {
    const handoff = await this.getHandoff(accountId, handoffId);
    if (!handoff) return null;
    const ts = now();
    const status = this.safeOptionalChoice(patch.status, ['pending', 'accepted', 'working', 'blocked', 'complete', 'stale', 'cancelled']) || handoff.status;
    await this.db.prepare(`
      UPDATE agent_handoffs
      SET status = ?, checkpoint = ?, result_summary = ?, updated_at = ?, completed_at = ?
      WHERE account_id = ? AND id = ?
    `).bind(
      status,
      patch.checkpoint !== undefined ? this.sanitizeOptional(patch.checkpoint, 1000) : handoff.checkpoint,
      patch.result_summary !== undefined ? this.sanitizeOptional(patch.result_summary, 1000) : handoff.result_summary,
      ts,
      status === 'complete' ? ts : handoff.completed_at,
      accountId,
      handoffId,
    ).run();
    return this.getHandoff(accountId, handoffId);
  }

  async listHandoffs(accountId: string, filters: { status?: string | null; agent_id?: string | null; limit?: number | null } = {}): Promise<AgentHandoff[]> {
    const rows = await this.db.prepare(`
      SELECT id, workflow_id, from_agent_id, to_agent_id, task, status, checkpoint,
             result_summary, stale_after_seconds, created_at, updated_at, completed_at
      FROM agent_handoffs
      WHERE account_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).bind(accountId, this.clampInt(filters.limit, 20, 100) * 2).all<HandoffRow>();
    const status = this.safeOptionalChoice(filters.status, ['pending', 'accepted', 'working', 'blocked', 'complete', 'stale', 'cancelled']);
    const agentId = this.sanitizeOptional(filters.agent_id, 128);
    return (rows.results || [])
      .map((row) => this.toHandoff(row))
      .filter((handoff) => !status || handoff.status === status)
      .filter((handoff) => !agentId || handoff.to_agent_id === agentId || handoff.from_agent_id === agentId)
      .slice(0, this.clampInt(filters.limit, 20, 100));
  }

  async canReadSharedFleet(accountId: string, accessAgentIds?: string[] | null): Promise<boolean> {
    if (!accessAgentIds || accessAgentIds.length === 0) return true;
    for (const agentId of accessAgentIds) {
      const permission = await this.getAgentPermission(accountId, agentId);
      if (!permission || permission.permission === 'shared' || permission.permission === 'production-critical' || permission.permission === 'read-only') {
        return true;
      }
    }
    return false;
  }

  async canWriteFleet(accountId: string, accessAgentIds?: string[] | null): Promise<boolean> {
    if (!accessAgentIds || accessAgentIds.length === 0) return true;
    for (const agentId of accessAgentIds) {
      const permission = await this.getAgentPermission(accountId, agentId);
      if (!permission || permission.permission === 'shared' || permission.permission === 'production-critical' || permission.permission === 'contribute-only') {
        return true;
      }
    }
    return false;
  }

  async setMemoryPermission(accountId: string, input: {
    agent_id: string;
    scope?: string | null;
    permission: string;
    resource_type?: string | null;
    resource_id?: string | null;
  }): Promise<PermissionRow> {
    const id = uuid();
    const ts = now();
    const agentId = this.sanitizeText(input.agent_id, 128);
    if (!agentId) throw new Error('agent_id is required');
    const scope = this.sanitizeText(input.scope || 'fleet', 80) || 'fleet';
    const resourceType = this.sanitizeText(input.resource_type || 'memory', 80) || 'memory';
    const resourceId = this.sanitizeOptional(input.resource_id, 128) || '';
    const permission = this.safeChoice(input.permission, ['read-only', 'contribute-only', 'private', 'shared', 'production-critical'], 'read-only') as MemoryPermission;

    await this.db.prepare(`
      DELETE FROM fleet_memory_permissions
      WHERE account_id = ? AND agent_id = ? AND scope = ? AND resource_type = ? AND resource_id = ?
    `).bind(accountId, agentId, scope, resourceType, resourceId).run();

    await this.db.prepare(`
      INSERT INTO fleet_memory_permissions
        (id, account_id, agent_id, scope, permission, resource_type, resource_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, accountId, agentId, scope, permission, resourceType, resourceId, ts, ts).run();

    const row = await this.db.prepare(`
      SELECT id, agent_id, scope, permission, resource_type, resource_id, created_at, updated_at
      FROM fleet_memory_permissions
      WHERE account_id = ? AND id = ?
      LIMIT 1
    `).bind(accountId, id).first<PermissionRow>();
    if (!row) throw new Error('Failed to set memory permission');
    return row;
  }

  async listMemoryPermissions(accountId: string, agentId?: string | null): Promise<PermissionRow[]> {
    const rows = await this.db.prepare(`
      SELECT id, agent_id, scope, permission, resource_type, resource_id, created_at, updated_at
      FROM fleet_memory_permissions
      WHERE account_id = ?
      ORDER BY updated_at DESC
      LIMIT 100
    `).bind(accountId).all<PermissionRow>();
    const safeAgentId = this.sanitizeOptional(agentId, 128);
    return (rows.results || []).filter((row) => !safeAgentId || row.agent_id === safeAgentId);
  }

  async buildAgentPerformance(accountId: string, options: { periodDays?: number | null; agentId?: string | null } = {}) {
    const days = this.clampInt(options.periodDays, 7, 90);
    const start = new Date(Date.now() - days * 86400000).toISOString();
    const previousStart = new Date(Date.now() - days * 2 * 86400000).toISOString();
    const agentId = this.sanitizeOptional(options.agentId, 128);
    const [rows, previousRows, riskRows] = await Promise.all([
      this.db.prepare(`
      SELECT decision_type, outcome_success, agent_id, session_id, created_at
      FROM decisions
      WHERE account_id = ? AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 500
      `).bind(accountId, start).all<{ decision_type: string; outcome_success: number | null; agent_id: string | null; session_id: string | null; created_at: string }>(),
      this.db.prepare(`
      SELECT decision_type, outcome_success, agent_id, session_id, created_at
      FROM decisions
      WHERE account_id = ? AND created_at > ? AND created_at <= ?
      ORDER BY created_at DESC
      LIMIT 500
      `).bind(accountId, previousStart, start).all<{ decision_type: string; outcome_success: number | null; agent_id: string | null; session_id: string | null; created_at: string }>(),
      this.db.prepare(`
      SELECT action, risk_level, decision, allow, agent_id, session_id, created_at
      FROM risk_gate_events
      WHERE account_id = ? AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 200
      `).bind(accountId, start).all<RiskGateProofRow>(),
    ]);
    const decisions = (rows.results || []).filter((row) => !agentId || row.agent_id === agentId || row.session_id === agentId);
    const previousDecisions = (previousRows.results || []).filter((row) => !agentId || row.agent_id === agentId || row.session_id === agentId);
    const recorded = decisions.filter((row) => row.outcome_success !== null && row.outcome_success !== undefined);
    const previousRecorded = previousDecisions.filter((row) => row.outcome_success !== null && row.outcome_success !== undefined);
    const successful = recorded.filter((row) => Number(row.outcome_success) === 1).length;
    const failed = recorded.filter((row) => Number(row.outcome_success) === 0).length;
    const successRate = recorded.length > 0 ? successful / recorded.length : 0;
    const previousSuccessful = previousRecorded.filter((row) => Number(row.outcome_success) === 1).length;
    const previousSuccessRate = previousRecorded.length > 0 ? previousSuccessful / previousRecorded.length : 0;
    const lessons = await this.listLessons(accountId, { agent_id: agentId, limit: 25 });
    const reusedThisPeriod = (lesson: FleetLesson) => this.timestampInRange(lesson.last_reused_at, start, null);
    const reusedPreviousPeriod = (lesson: FleetLesson) => this.timestampInRange(lesson.last_reused_at, previousStart, start);
    const reusedWinning = lessons.filter((lesson) => lesson.outcome_success === true && lesson.reuse_count > 0 && reusedThisPeriod(lesson)).length;
    const avoidedMistakes = lessons.filter((lesson) => lesson.outcome_success === false && lesson.reuse_count > 0 && reusedThisPeriod(lesson)).length;
    const previousReusedWinning = lessons.filter((lesson) => lesson.outcome_success === true && lesson.reuse_count > 0 && reusedPreviousPeriod(lesson)).length;
    const failedPatterns = this.failedPatterns(decisions);
    const riskGateProof = this.blockedRiskGateProof((riskRows.results || []).filter((row) => !agentId || row.agent_id === agentId || row.session_id === agentId));
    const reliability = this.round(Math.min(1, (successRate * 0.65) + (Math.min(recorded.length / 20, 1) * 0.2) + (Math.min(reusedWinning / 5, 1) * 0.15)));
    const previousReliability = this.round(Math.min(1, (previousSuccessRate * 0.65) + (Math.min(previousRecorded.length / 20, 1) * 0.2) + (Math.min(previousReusedWinning / 5, 1) * 0.15)));
    const preventedBadActions = avoidedMistakes + riskGateProof.blocked_count + failedPatterns.reduce((sum, pattern) => sum + Math.min(pattern.failures, 3), 0);
    const estimatedTokensSaved = (reusedWinning * 1200) + (avoidedMistakes * 1800) + (riskGateProof.blocked_count * 3200) + (preventedBadActions * 2400);
    const estimatedMinutesSaved = (reusedWinning * 8) + (avoidedMistakes * 12) + (riskGateProof.blocked_count * 24) + (preventedBadActions * 18);

    return {
      period: { days, start, end: now() },
      scope: { agent_id: agentId },
      avoided_mistakes: avoidedMistakes,
      avoided_repeated_mistakes: avoidedMistakes,
      prevented_bad_actions: preventedBadActions,
      prevented_bad_action_types: this.uniqueStrings([
        ...riskGateProof.action_types,
        ...failedPatterns.slice(0, 5).map((pattern) => pattern.decision_type),
      ]).slice(0, 5),
      blocked_risky_actions: riskGateProof.blocked_count,
      blocked_risky_action_examples: riskGateProof.examples,
      reused_winning_decisions: reusedWinning,
      failed_patterns: failedPatterns,
      token_time_saved_estimate: {
        decisions_reused: reusedWinning + avoidedMistakes,
        prevented_bad_actions: preventedBadActions,
        estimated_tokens_saved: estimatedTokensSaved,
        estimated_minutes_saved: estimatedMinutesSaved,
        method: 'Heuristic estimate from reused winning lessons, reused failure lessons, blocked risk-gate events, and repeated failed action patterns.',
      },
      agent_reliability_score: reliability,
      reliability_trend: {
        current: reliability,
        previous: previousReliability,
        delta: this.round(reliability - previousReliability),
        direction: reliability > previousReliability ? 'improving' : reliability < previousReliability ? 'declining' : 'flat',
      },
      outcome_coverage: this.round(decisions.length > 0 ? recorded.length / decisions.length : 0),
      proof_summary: {
        headline: riskGateProof.blocked_count > 0
          ? `Marrow blocked or required review for ${riskGateProof.blocked_count} risky action(s) in this period.`
          : preventedBadActions > 0
          ? `Marrow has evidence of ${preventedBadActions} avoided or preventable risky action(s) in this period.`
          : reusedWinning > 0
          ? `Marrow reused ${reusedWinning} winning decision(s) in this period.`
          : 'Marrow is collecting outcome proof; more closed outcomes will strengthen value estimates.',
        investor_ready: recorded.length >= 10 || preventedBadActions > 0 || reusedWinning > 0,
        owner_summary: `Reliability ${Math.round(reliability * 100)}%, outcome coverage ${Math.round((decisions.length > 0 ? recorded.length / decisions.length : 0) * 100)}%, ${riskGateProof.blocked_count} risky action(s) blocked/reviewed, estimated ${estimatedMinutesSaved} minutes saved.`,
      },
      top_reusable_lessons: lessons.slice(0, 5),
      recommended_next_improvements: this.performanceRecommendations({ decisions: decisions.length, recorded: recorded.length, failed, reusedWinning, avoidedMistakes }),
    };
  }

  private async getLesson(accountId: string, id: string): Promise<FleetLesson | null> {
    const row = await this.db.prepare(`
      SELECT id, source_decision_id, agent_id, lesson_type, title, summary, action_pattern,
             outcome_success, confidence, score, reuse_count, visibility, tags,
             created_at, updated_at, last_reused_at
      FROM fleet_lessons
      WHERE account_id = ? AND id = ?
      LIMIT 1
    `).bind(accountId, id).first<LessonRow>();
    return row ? this.toLesson(row) : null;
  }

  private async getDeploymentMemory(accountId: string, id: string): Promise<DeploymentMemory | null> {
    const row = await this.db.prepare(`
      SELECT id, agent_id, workflow_id, release_id, pr_url, commit_sha, environment, status, tests,
             smoke_result, rollback_plan, prod_health, incident_summary, created_at, updated_at
      FROM deployment_memories
      WHERE account_id = ? AND id = ?
      LIMIT 1
    `).bind(accountId, id).first<DeploymentMemoryRow>();
    return row ? this.toDeploymentMemory(row) : null;
  }

  private async getHandoff(accountId: string, id: string): Promise<AgentHandoff | null> {
    const row = await this.db.prepare(`
      SELECT id, workflow_id, from_agent_id, to_agent_id, task, status, checkpoint,
             result_summary, stale_after_seconds, created_at, updated_at, completed_at
      FROM agent_handoffs
      WHERE account_id = ? AND id = ?
      LIMIT 1
    `).bind(accountId, id).first<HandoffRow>();
    return row ? this.toHandoff(row) : null;
  }

  private toLesson(row: LessonRow): FleetLesson {
    return {
      ...row,
      outcome_success: row.outcome_success === null || row.outcome_success === undefined ? null : Number(row.outcome_success) === 1,
      confidence: this.round(Number(row.confidence) || 0),
      score: this.round(Number(row.score) || 0),
      reuse_count: Number(row.reuse_count) || 0,
      tags: this.parseJsonArray(row.tags),
    };
  }

  private async getAgentPermission(accountId: string, agentId: string): Promise<PermissionRow | null> {
    return this.db.prepare(`
      SELECT id, agent_id, scope, permission, resource_type, resource_id, created_at, updated_at
      FROM fleet_memory_permissions
      WHERE account_id = ? AND agent_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).bind(accountId, agentId).first<PermissionRow>();
  }

  private canAccessLesson(row: Pick<FleetLesson | LessonRow, 'agent_id' | 'visibility'>, accessAgentIds: string[] | null): boolean {
    if (!accessAgentIds || accessAgentIds.length === 0) return true;
    if (row.agent_id && accessAgentIds.includes(row.agent_id)) return true;
    return row.visibility !== 'private';
  }

  private canAccessAgentRow(agentId: string | null, accessAgentIds: string[] | null): boolean {
    if (!accessAgentIds || accessAgentIds.length === 0) return true;
    return Boolean(agentId && accessAgentIds.includes(agentId));
  }

  private toDeploymentMemory(row: DeploymentMemoryRow): DeploymentMemory {
    return { ...row, tests: this.parseJsonArray(row.tests) };
  }

  private toHandoff(row: HandoffRow): AgentHandoff {
    const updated = Date.parse(row.updated_at || row.created_at);
    const stale = !['complete', 'cancelled'].includes(row.status) && Number.isFinite(updated) && Date.now() - updated > (Number(row.stale_after_seconds) || 1800) * 1000;
    return { ...row, stale_after_seconds: Number(row.stale_after_seconds) || 1800, stale };
  }

  private extractAction(context: string | null): string | null {
    if (!context) return null;
    try {
      const parsed = JSON.parse(context) as Record<string, unknown>;
      const action = parsed.action || parsed.command || parsed.description || parsed.intent;
      return typeof action === 'string' ? this.sanitizeText(action, 500) : null;
    } catch {
      return this.sanitizeText(context, 500);
    }
  }

  private failedPatterns(rows: Array<{ decision_type: string; outcome_success: number | null }>) {
    const counts = new Map<string, { total: number; failed: number }>();
    for (const row of rows) {
      if (row.outcome_success === null || row.outcome_success === undefined) continue;
      const key = this.sanitizeText(row.decision_type || 'unknown', 80) || 'unknown';
      const current = counts.get(key) || { total: 0, failed: 0 };
      current.total += 1;
      if (Number(row.outcome_success) === 0) current.failed += 1;
      counts.set(key, current);
    }
    return [...counts.entries()]
      .filter(([, value]) => value.failed > 0)
      .map(([decision_type, value]) => ({
        decision_type,
        failures: value.failed,
        failure_rate: this.round(value.failed / value.total),
      }))
      .sort((a, b) => b.failures - a.failures)
      .slice(0, 5);
  }

  private blockedRiskGateProof(rows: RiskGateProofRow[]) {
    const blocked = rows.filter((row) => {
      const decision = String(row.decision || '').toLowerCase();
      return Number(row.allow) === 0 || decision === 'block' || decision === 'review_required';
    });
    const examples = blocked.slice(0, 5).map((row) => ({
      action_type: this.riskActionType(row.action),
      risk_level: this.safeChoice(row.risk_level, ['low', 'medium', 'high'], 'low'),
      decision: this.safeChoice(row.decision, ['allow', 'warn', 'review_required', 'block'], 'review_required'),
      created_at: row.created_at,
      proof_safe: true,
    }));
    return {
      blocked_count: blocked.length,
      action_types: this.uniqueStrings(examples.map((example) => example.action_type)),
      examples,
    };
  }

  private riskActionType(action: string | null | undefined): string {
    const lower = String(action || '').toLowerCase();
    if (/\bdeploy|worker|production|prod|release\b/.test(lower)) return 'deploy';
    if (/\bpublish|npm|package\b/.test(lower)) return 'publish';
    if (/\bmerge|pull request|pr\b/.test(lower)) return 'merge';
    if (/\bmigration|database|d1|sql\b/.test(lower)) return 'database';
    if (/\bsecret|token|credential|key|permission|auth\b/.test(lower)) return 'security';
    if (/\brollback|incident\b/.test(lower)) return 'incident';
    return 'risky_action';
  }

  private uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
  }

  private timestampInRange(value: string | null | undefined, start: string, end: string | null): boolean {
    if (!value) return false;
    const time = Date.parse(value);
    const startTime = Date.parse(start);
    const endTime = end ? Date.parse(end) : Number.POSITIVE_INFINITY;
    return Number.isFinite(time) && Number.isFinite(startTime) && time >= startTime && time < endTime;
  }

  private performanceRecommendations(input: { decisions: number; recorded: number; failed: number; reusedWinning: number; avoidedMistakes: number }): string[] {
    const recommendations: string[] = [];
    if (input.decisions === 0) recommendations.push('Install passive hooks or verify the agent is sending decisions.');
    if (input.decisions > 0 && input.recorded / input.decisions < 0.6) recommendations.push('Commit more outcomes so Marrow can rank which decisions actually worked.');
    if (input.failed > 0) recommendations.push('Pull fleet lessons before repeating failed decision types.');
    if (input.reusedWinning + input.avoidedMistakes === 0) recommendations.push('Call fleet lessons before deploys, migrations, and handoffs to reuse proven work.');
    if (recommendations.length === 0) recommendations.push('Keep routing high-risk actions through the risk gate and reuse top lessons.');
    return recommendations.slice(0, 5);
  }

  private scoreLesson(success: boolean | null, confidence: number, reuseCount: number, createdAt: string): number {
    const ageHours = Math.max(0, (Date.now() - Date.parse(createdAt)) / 3600000);
    const recency = Math.max(0.1, 1 - ageHours / (24 * 90));
    const outcome = success === true ? 0.45 : success === false ? 0.2 : 0.3;
    const reuse = Math.min(0.25, reuseCount * 0.03);
    return this.round(Math.min(1, outcome + confidence * 0.25 + reuse + recency * 0.1));
  }

  private titleFromSummary(summary: string): string {
    return this.sanitizeText(summary, 80) || 'Fleet lesson';
  }

  private normalizeLessonType(value: string | null | undefined, success?: boolean | null): LessonType {
    const safe = this.safeOptionalChoice(value, ['success', 'failure', 'deploy', 'incident', 'handoff', 'general']);
    if (safe) return safe as LessonType;
    if (success === true) return 'success';
    if (success === false) return 'failure';
    return 'general';
  }

  private normalizeLessonTypeFilter(value: string | null | undefined): LessonType | null {
    const safe = this.safeOptionalChoice(value, ['success', 'failure', 'deploy', 'incident', 'handoff', 'general']);
    return safe as LessonType | null;
  }

  private normalizeVisibility(value: string | null | undefined): LessonVisibility {
    return this.safeChoice(value, ['private', 'shared', 'production-critical'], 'shared') as LessonVisibility;
  }

  private sanitizeUrl(value: string | null | undefined): string | null {
    const safe = String(value || '').replace(/\s+/g, '').slice(0, 500);
    if (!safe) return null;
    try {
      const url = new URL(safe);
      if (url.protocol !== 'https:') return null;
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString().slice(0, 500);
    } catch {
      return null;
    }
  }

  private sanitizeTags(value: unknown): string[] {
    return this.sanitizeStringArray(value, 12, 40);
  }

  private sanitizeStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
    if (!Array.isArray(value)) return [];
    const result: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const safe = this.sanitizeText(item, maxLength);
      if (safe && !result.includes(safe)) result.push(safe);
      if (result.length >= maxItems) break;
    }
    return result;
  }

  private sanitizeOptional(value: string | null | undefined, maxLength: number): string | null {
    const safe = this.sanitizeText(value || '', maxLength);
    return safe || null;
  }

  private sanitizeText(value: string, maxLength: number): string {
    return String(value || '')
      .replace(/(\B--(?:password|pass|secret|api-key|apikey|token|auth|access-token|client-secret|private-key|key)=)([^\s"'`]+|"[^"]*"|'[^']*')/gi, '$1[redacted]')
      .replace(/(\B--(?:password|pass|secret|api-key|apikey|token|auth|access-token|client-secret|private-key|key)\s+)([^\s"'`]+|"[^"]*"|'[^']*')/gi, '$1[redacted]')
      .replace(/\b(?:mrw|sk|ghp|github_pat|npm)_[A-Za-z0-9_./-]{12,}\b/g, '[redacted]')
      .replace(/\bcfut_[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
      .replace(/\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}\b/g, '[redacted]')
      .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, '[redacted-auth]')
      .replace(/\b(?:api[_-]?key|token|secret|password|passwd|pwd|authorization)\s*[:=]\s*["']?[^"'\s,;]{8,}/gi, '[redacted-secret]')
      .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\b/g, '[redacted-jwt]')
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
  }

  private parseJsonArray(value: string | null): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  private safeJson(value: unknown, fallback: unknown): string {
    try {
      return JSON.stringify(value ?? fallback);
    } catch {
      return JSON.stringify(fallback);
    }
  }

  private safeChoice(value: string | null | undefined, allowed: string[], fallback: string): string {
    return allowed.includes(String(value || '')) ? String(value) : fallback;
  }

  private safeOptionalChoice(value: string | null | undefined, allowed: string[]): string | null {
    return allowed.includes(String(value || '')) ? String(value) : null;
  }

  private clampNumber(value: number | null | undefined, fallback: number, min: number, max: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  private clampInt(value: number | string | null | undefined, fallback: number, max: number): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(max, Math.max(1, Math.floor(n)));
  }

  private round(value: number): number {
    return Math.round(value * 1000) / 1000;
  }
}
