/**
 * Fleet Service — live fleet dashboard + SSE stream (V5 Phase 1)
 */

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
    const now1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Mark active agents
    await this.db
      .prepare(
        `UPDATE agents SET status = 'active', updated_at = datetime('now')
         WHERE account_id = ? AND status != 'archived' AND last_active_at >= ?`
      )
      .bind(accountId, now5m)
      .run();

    // Mark inactive agents (active within last hour but not last 5min)
    await this.db
      .prepare(
        `UPDATE agents SET status = 'inactive', updated_at = datetime('now')
         WHERE account_id = ? AND status != 'archived'
         AND (last_active_at < ? OR last_active_at IS NULL)
         AND (last_active_at >= ? OR last_active_at IS NULL)`
      )
      .bind(accountId, now5m, now1h)
      .run();
  }
}
