/**
 * Fleet Service — agent registry + live fleet dashboard + SSE stream.
 */
import { now, randomHex, sha256, uuid } from '../utils/crypto';

export interface Agent {
  id: string;
  account_id: string;
  name: string;
  role: string | null;
  specialty: string | null;
  avatar_url: string | null;
  status: 'active' | 'inactive' | 'archived';
  total_decisions: number;
  success_rate: number | null;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentWithKey extends Agent {
  api_key: string;
}

interface AgentFilters {
  status?: string;
  limit?: number;
}

interface AgentPatch {
  name?: string;
  role?: string;
  specialty?: string;
  status?: string;
  avatar_url?: string;
}

export interface FleetStatus {
  fleet: {
    total_agents: number;
    active_agents: number;
    idle_agents: number;
    stalled_agents: number;
  };
  agents: FleetAgentStatus[];
  active_workflows: FleetWorkflow[];
  recent_decisions: FleetDecision[];
  alerts: FleetAlert[];
}

interface FleetAgentStatus {
  id: string;
  name: string;
  role: string | null;
  status: string;
  current_action: string | null;
  current_workflow: string | null;
  current_step: number | null;
  last_active_seconds_ago: number | null;
  success_rate_7d: number | null;
  decisions_this_week: number;
}

interface FleetWorkflow {
  instance_id: string;
  template_name: string;
  current_step: number;
  current_step_name: string | null;
  assigned_agent: string | null;
  started_at: string;
  stalled: boolean;
}

interface FleetDecision {
  id: string;
  agent_name: string | null;
  action: string;
  outcome: string;
  when: string;
}

interface FleetAlert {
  severity: 'info' | 'warning' | 'critical';
  type: string;
  message: string;
  triggered_at: string;
}

export class FleetService {
  constructor(private db: D1Database) {}

  async registerAgent(
    accountId: string,
    input: { name: string; role?: string; specialty?: string; avatar_url?: string }
  ): Promise<AgentWithKey> {
    const id = uuid();
    const ts = now();
    const name = (input.name || '').trim().slice(0, 100);
    if (!name) throw new Error('Agent name is required');

    const role = input.role?.trim().slice(0, 100) || null;
    const specialty = input.specialty?.trim().slice(0, 200) || null;
    const avatarUrl = input.avatar_url?.trim().slice(0, 500) || null;
    const rawKey = `marrow_agent_${randomHex(32)}`;
    const keyHash = await sha256(rawKey);

    await this.db.prepare(
      `INSERT INTO agents (id, account_id, name, role, specialty, avatar_url, api_key_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, accountId, name, role, specialty, avatarUrl, keyHash, ts, ts).run();

    return {
      id,
      account_id: accountId,
      name,
      role,
      specialty,
      avatar_url: avatarUrl,
      status: 'active',
      total_decisions: 0,
      success_rate: null,
      last_active_at: null,
      created_at: ts,
      updated_at: ts,
      api_key: rawKey,
    };
  }

  async listAgents(accountId: string, filters: AgentFilters = {}): Promise<Agent[]> {
    const status = filters.status || 'active';
    const limit = Math.min(Math.max(filters.limit || 50, 1), 100);

    const res = await this.db.prepare(
      `SELECT id, account_id, name, role, specialty, avatar_url, status,
              total_decisions, success_rate, last_active_at, created_at, updated_at
       FROM agents
       WHERE account_id = ? AND status = ?
       ORDER BY last_active_at DESC NULLS LAST, created_at DESC
       LIMIT ?`
    ).bind(accountId, status, limit).all<Agent>();

    return res.results || [];
  }

  async getAgent(id: string, accountId: string): Promise<Agent | null> {
    return this.db.prepare(
      `SELECT id, account_id, name, role, specialty, avatar_url, status,
              total_decisions, success_rate, last_active_at, created_at, updated_at
       FROM agents
       WHERE id = ? AND account_id = ?`
    ).bind(id, accountId).first<Agent>();
  }

  async getAgentStats(id: string, accountId: string): Promise<{
    success_rate_7d: number | null;
    success_rate_30d: number | null;
    decisions_7d: number;
    decisions_30d: number;
    top_decision_types: { type: string; count: number }[];
  }> {
    const now7d = new Date(Date.now() - 7 * 86400000).toISOString();
    const now30d = new Date(Date.now() - 30 * 86400000).toISOString();

    const stats7d = await this.db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as successes
       FROM decisions
       WHERE agent_id = ? AND account_id = ? AND created_at >= ?
         AND outcome_recorded_at IS NOT NULL`
    ).bind(id, accountId, now7d).first<{ total: number; successes: number }>();

    const stats30d = await this.db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as successes
       FROM decisions
       WHERE agent_id = ? AND account_id = ? AND created_at >= ?
         AND outcome_recorded_at IS NOT NULL`
    ).bind(id, accountId, now30d).first<{ total: number; successes: number }>();

    const topTypes = await this.db.prepare(
      `SELECT decision_type as type, COUNT(*) as count
       FROM decisions
       WHERE agent_id = ? AND account_id = ?
       GROUP BY decision_type
       ORDER BY count DESC
       LIMIT 5`
    ).bind(id, accountId).all<{ type: string; count: number }>();

    const s7 = stats7d?.total ? (stats7d.successes || 0) / stats7d.total : null;
    const s30 = stats30d?.total ? (stats30d.successes || 0) / stats30d.total : null;

    return {
      success_rate_7d: s7,
      success_rate_30d: s30,
      decisions_7d: stats7d?.total || 0,
      decisions_30d: stats30d?.total || 0,
      top_decision_types: topTypes.results || [],
    };
  }

  async updateAgent(id: string, accountId: string, patch: AgentPatch): Promise<Agent | null> {
    const agent = await this.getAgent(id, accountId);
    if (!agent) return null;

    const sets: string[] = [];
    const binds: unknown[] = [];

    if (patch.name !== undefined) {
      const n = patch.name.trim().slice(0, 100);
      if (!n) throw new Error('Agent name cannot be empty');
      sets.push('name = ?');
      binds.push(n);
    }
    if (patch.role !== undefined) {
      sets.push('role = ?');
      binds.push(patch.role.trim().slice(0, 100) || null);
    }
    if (patch.specialty !== undefined) {
      sets.push('specialty = ?');
      binds.push(patch.specialty.trim().slice(0, 200) || null);
    }
    if (patch.status !== undefined) {
      if (!['active', 'inactive', 'archived'].includes(patch.status)) {
        throw new Error('Invalid status');
      }
      sets.push('status = ?');
      binds.push(patch.status);
    }
    if (patch.avatar_url !== undefined) {
      sets.push('avatar_url = ?');
      binds.push(patch.avatar_url.trim().slice(0, 500) || null);
    }

    if (sets.length === 0) return agent;

    sets.push('updated_at = ?');
    binds.push(now());
    binds.push(id, accountId);

    await this.db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ? AND account_id = ?`).bind(...binds).run();
    return this.getAgent(id, accountId);
  }

  async archiveAgent(id: string, accountId: string): Promise<boolean> {
    const res = await this.db.prepare(
      `UPDATE agents SET status = 'archived', updated_at = ? WHERE id = ? AND account_id = ? AND status != 'archived'`
    ).bind(now(), id, accountId).run();
    return (res.meta?.changes || 0) > 0;
  }

  async updateAgentStats(agentId: string): Promise<void> {
    await this.db.prepare(
      `UPDATE agents SET
         total_decisions = (SELECT COUNT(*) FROM decisions WHERE agent_id = ?),
         success_rate = (
           SELECT CASE WHEN COUNT(*) > 0
             THEN CAST(SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
             ELSE NULL END
           FROM decisions WHERE agent_id = ? AND outcome_recorded_at IS NOT NULL
         ),
         last_active_at = (SELECT MAX(created_at) FROM decisions WHERE agent_id = ?),
         updated_at = ?
       WHERE id = ?`
    ).bind(agentId, agentId, agentId, now(), agentId).run();
  }

  async getAgentByKeyHash(keyHash: string): Promise<Agent | null> {
    return this.db.prepare(
      `SELECT id, account_id, name, role, specialty, avatar_url, status,
              total_decisions, success_rate, last_active_at, created_at, updated_at
       FROM agents WHERE api_key_hash = ? AND status = 'active'`
    ).bind(keyHash).first<Agent>();
  }

  /**
   * Get full fleet status for an account.
   */
  async getFleetStatus(accountId: string): Promise<FleetStatus> {
    const nowMs = Date.now();
    const now7d = new Date(nowMs - 7 * 86400000).toISOString();

    // 1. Agent summary
    // L1 fix: Cap displayed agents to 20 to avoid N+1 query explosion
    const agentRows = await this.db
      .prepare(
        `SELECT id, name, role, status, last_active_at, total_decisions, success_rate
         FROM agents
         WHERE account_id = ? AND status != 'archived'
         ORDER BY last_active_at DESC NULLS LAST
         LIMIT 20`
      )
      .bind(accountId)
      .all<{
        id: string; name: string; role: string | null; status: string;
        last_active_at: string | null; total_decisions: number; success_rate: number | null;
      }>();

    const agents = agentRows.results || [];
    let activeCount = 0;
    let idleCount = 0;
    let stalledCount = 0;

    // Get latest decision per agent for current_action
    const agentStatuses: FleetAgentStatus[] = [];
    for (const agent of agents) {
      const lastActiveMs = agent.last_active_at ? new Date(agent.last_active_at).getTime() : 0;
      const secondsAgo = lastActiveMs ? Math.round((nowMs - lastActiveMs) / 1000) : null;

      // Classify: active (<5min), idle (5min-1hr), stalled (>1hr)
      let derivedStatus = 'inactive';
      if (secondsAgo !== null) {
        if (secondsAgo < 300) { derivedStatus = 'working'; activeCount++; }
        else if (secondsAgo < 3600) { derivedStatus = 'idle'; idleCount++; }
        else { derivedStatus = 'stalled'; stalledCount++; }
      }

      // Get the agent's latest decision for current_action
      const latestDecision = await this.db
        .prepare(
          `SELECT context FROM decisions
           WHERE agent_id = ? AND account_id = ?
           ORDER BY created_at DESC LIMIT 1`
        )
        .bind(agent.id, accountId)
        .first<{ context: string }>();

      let currentAction: string | null = null;
      if (latestDecision?.context) {
        try {
          const parsed = JSON.parse(latestDecision.context);
          currentAction = (parsed.action || '').toString().slice(0, 200) || null;
        } catch {
          currentAction = latestDecision.context.slice(0, 200);
        }
      }

      // Get current workflow for this agent
      const activeWf = await this.db
        .prepare(
          `SELECT wi.id, w.name, wi.current_step
           FROM workflow_instances wi
           JOIN workflows w ON w.id = wi.workflow_id
           WHERE wi.agent_id = ? AND wi.status = 'running'
           ORDER BY wi.started_at DESC LIMIT 1`
        )
        .bind(agent.id)
        .first<{ id: string; name: string; current_step: number }>();

      // 7d stats
      const stats7d = await this.db
        .prepare(
          `SELECT COUNT(*) as cnt,
                  CASE WHEN COUNT(*) > 0
                    THEN CAST(SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
                    ELSE NULL END as rate
           FROM decisions
           WHERE agent_id = ? AND account_id = ? AND created_at >= ?
             AND outcome_recorded_at IS NOT NULL`
        )
        .bind(agent.id, accountId, now7d)
        .first<{ cnt: number; rate: number | null }>();

      agentStatuses.push({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        status: derivedStatus,
        current_action: currentAction,
        current_workflow: activeWf?.name || null,
        current_step: activeWf?.current_step || null,
        last_active_seconds_ago: secondsAgo,
        success_rate_7d: stats7d?.rate || null,
        decisions_this_week: stats7d?.cnt || 0,
      });
    }

    // 2. Active workflows
    const wfRows = await this.db
      .prepare(
        `SELECT wi.id as instance_id, w.name as template_name, wi.current_step,
                wi.agent_id, wi.started_at,
                ws.step_name as current_step_name
         FROM workflow_instances wi
         JOIN workflows w ON w.id = wi.workflow_id AND w.account_id = ?
         LEFT JOIN workflow_steps ws ON ws.workflow_id = w.id AND ws.step_order = wi.current_step
         WHERE wi.status = 'running'
         ORDER BY wi.started_at DESC
         LIMIT 20`
      )
      .bind(accountId)
      .all<{
        instance_id: string; template_name: string; current_step: number;
        agent_id: string | null; started_at: string; current_step_name: string | null;
      }>();

    const activeWorkflows: FleetWorkflow[] = (wfRows.results || []).map((wf) => {
      const startedMs = new Date(wf.started_at).getTime();
      const stalledHours = (nowMs - startedMs) / 3600000;
      // Resolve agent name
      const agentName = agents.find((a) => a.id === wf.agent_id)?.name || wf.agent_id;
      return {
        instance_id: wf.instance_id,
        template_name: wf.template_name,
        current_step: wf.current_step,
        current_step_name: wf.current_step_name,
        assigned_agent: agentName,
        started_at: wf.started_at,
        stalled: stalledHours > 24,
      };
    });

    // 3. Recent decisions (last 20)
    const decRows = await this.db
      .prepare(
        `SELECT d.id, d.context, d.outcome_details, d.outcome_success, d.created_at,
                a.name as agent_name
         FROM decisions d
         LEFT JOIN agents a ON a.id = d.agent_id
         WHERE d.account_id = ?
         ORDER BY d.created_at DESC
         LIMIT 20`
      )
      .bind(accountId)
      .all<{
        id: string; context: string; outcome_details: string | null;
        outcome_success: number | null; created_at: string; agent_name: string | null;
      }>();

    const recentDecisions: FleetDecision[] = (decRows.results || []).map((d) => {
      let action = '';
      try {
        const parsed = JSON.parse(d.context);
        action = (parsed.action || '').toString().slice(0, 200);
      } catch {
        action = d.context?.slice(0, 200) || '';
      }

      const createdMs = new Date(d.created_at).getTime();
      const secsAgo = Math.round((nowMs - createdMs) / 1000);
      const when = secsAgo < 60 ? `${secsAgo} seconds ago`
        : secsAgo < 3600 ? `${Math.round(secsAgo / 60)} minutes ago`
        : secsAgo < 86400 ? `${Math.round(secsAgo / 3600)} hours ago`
        : `${Math.round(secsAgo / 86400)} days ago`;

      return {
        id: d.id,
        agent_name: d.agent_name,
        action,
        outcome: d.outcome_success === 1 ? 'Success' : d.outcome_success === 0 ? 'Failure' : 'Pending',
        when,
      };
    });

    // 4. Alerts (stalled workflows + agent anomalies)
    const alerts: FleetAlert[] = [];

    // Stalled workflows
    for (const wf of activeWorkflows) {
      if (wf.stalled) {
        alerts.push({
          severity: 'warning',
          type: 'stalled_workflow',
          message: `Workflow "${wf.template_name}" has been on step ${wf.current_step} (${wf.current_step_name || 'unknown'}) for over 24 hours.`,
          triggered_at: new Date().toISOString(),
        });
      }
    }

    // Stalled agents
    for (const agent of agentStatuses) {
      if (agent.status === 'stalled') {
        alerts.push({
          severity: 'info',
          type: 'agent_stalled',
          message: `Agent "${agent.name}" hasn't been active for over an hour.`,
          triggered_at: new Date().toISOString(),
        });
      }
    }

    return {
      fleet: {
        total_agents: agents.length,
        active_agents: activeCount,
        idle_agents: idleCount,
        stalled_agents: stalledCount,
      },
      agents: agentStatuses,
      active_workflows: activeWorkflows,
      recent_decisions: recentDecisions,
      alerts,
    };
  }

  /**
   * Get fleet events since a timestamp for SSE streaming.
   */
  async getFleetEvents(
    accountId: string,
    since: string
  ): Promise<{ type: string; data: unknown; timestamp: string }[]> {
    const events: { type: string; data: unknown; timestamp: string }[] = [];

    // New decisions since timestamp
    const newDecisions = await this.db
      .prepare(
        `SELECT d.id, d.context, d.outcome_success, d.created_at, a.name as agent_name
         FROM decisions d
         LEFT JOIN agents a ON a.id = d.agent_id
         WHERE d.account_id = ? AND d.created_at > ?
         ORDER BY d.created_at ASC
         LIMIT 50`
      )
      .bind(accountId, since)
      .all<{
        id: string; context: string; outcome_success: number | null;
        created_at: string; agent_name: string | null;
      }>();

    for (const d of newDecisions.results || []) {
      let action = '';
      try { action = JSON.parse(d.context)?.action || ''; } catch { action = ''; }
      events.push({
        type: 'decision.created',
        data: { id: d.id, agent_name: d.agent_name, action: action.slice(0, 200), success: d.outcome_success },
        timestamp: d.created_at,
      });
    }

    // Workflow step advances since timestamp
    const wfAdvances = await this.db
      .prepare(
        `SELECT wsr.instance_id, wsr.step_order, wsr.outcome, wsr.created_at, wsr.agent_id,
                w.name as workflow_name
         FROM workflow_step_results wsr
         JOIN workflow_instances wi ON wi.id = wsr.instance_id
         JOIN workflows w ON w.id = wi.workflow_id AND w.account_id = ?
         WHERE wsr.created_at > ?
         ORDER BY wsr.created_at ASC
         LIMIT 50`
      )
      .bind(accountId, since)
      .all<{
        instance_id: string; step_order: number; outcome: string | null;
        created_at: string; agent_id: string | null; workflow_name: string;
      }>();

    for (const wf of wfAdvances.results || []) {
      events.push({
        type: 'workflow.advanced',
        data: {
          instance_id: wf.instance_id,
          workflow_name: wf.workflow_name,
          step: wf.step_order,
          agent_id: wf.agent_id,
          outcome: wf.outcome?.slice(0, 200),
        },
        timestamp: wf.created_at,
      });
    }

    return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Update agent statuses based on recent activity (called from cron).
   * Agents with decisions in last 5min → active, 5min-1hr → inactive, else → stalled.
   */
  async updateAgentStatuses(accountId: string): Promise<void> {
    const now5m = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const now30m = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    // Mark active agents (<5min since last activity)
    await this.db
      .prepare(
        `UPDATE agents SET status = 'active', updated_at = datetime('now')
         WHERE account_id = ? AND status != 'archived' AND last_active_at >= ?`
      )
      .bind(accountId, now5m)
      .run();

    // Mark idle agents (5-30min since last activity)
    await this.db
      .prepare(
        `UPDATE agents SET status = 'inactive', updated_at = datetime('now')
         WHERE account_id = ? AND status != 'archived'
         AND last_active_at < ? AND last_active_at >= ?`
      )
      .bind(accountId, now5m, now30m)
      .run();

    // Mark stalled agents (>30min since last activity or never active)
    await this.db
      .prepare(
        `UPDATE agents SET status = 'inactive', updated_at = datetime('now')
         WHERE account_id = ? AND status != 'archived'
         AND (last_active_at < ? OR last_active_at IS NULL)`
      )
      .bind(accountId, now30m)
      .run();
  }
}
