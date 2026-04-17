/**
 * Agent Service — fleet agent registry (V5 Phase 1)
 */
import { uuid, now, sha256, randomHex } from '../utils/crypto';

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

export class AgentService {
  constructor(private db: D1Database) {}

  /**
   * Register a new agent in the fleet.
   * Generates a unique agent-scoped API key (marrow_agent_<hex>).
   */
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

    // Generate agent-scoped API key
    const rawKey = `marrow_agent_${randomHex(32)}`;
    const keyHash = await sha256(rawKey);

    await this.db
      .prepare(
        `INSERT INTO agents (id, account_id, name, role, specialty, avatar_url, api_key_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, accountId, name, role, specialty, avatarUrl, keyHash, ts, ts)
      .run();

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

  /**
   * List agents for an account with optional filters.
   */
  async listAgents(accountId: string, filters: AgentFilters = {}): Promise<Agent[]> {
    const status = filters.status || 'active';
    const limit = Math.min(Math.max(filters.limit || 50, 1), 100);

    const res = await this.db
      .prepare(
        `SELECT id, account_id, name, role, specialty, avatar_url, status,
                total_decisions, success_rate, last_active_at, created_at, updated_at
         FROM agents
         WHERE account_id = ? AND status = ?
         ORDER BY last_active_at DESC NULLS LAST, created_at DESC
         LIMIT ?`
      )
      .bind(accountId, status, limit)
      .all<Agent>();

    return res.results || [];
  }

  /**
   * Get a single agent by ID (scoped to account).
   * Includes 7d/30d stats computed from decisions.
   */
  async getAgent(id: string, accountId: string): Promise<Agent | null> {
    return this.db
      .prepare(
        `SELECT id, account_id, name, role, specialty, avatar_url, status,
                total_decisions, success_rate, last_active_at, created_at, updated_at
         FROM agents
         WHERE id = ? AND account_id = ?`
      )
      .bind(id, accountId)
      .first<Agent>();
  }

  /**
   * Get agent stats (7d/30d success rate, top decision types).
   */
  async getAgentStats(id: string, accountId: string): Promise<{
    success_rate_7d: number | null;
    success_rate_30d: number | null;
    decisions_7d: number;
    decisions_30d: number;
    top_decision_types: { type: string; count: number }[];
  }> {
    const now7d = new Date(Date.now() - 7 * 86400000).toISOString();
    const now30d = new Date(Date.now() - 30 * 86400000).toISOString();

    const stats7d = await this.db
      .prepare(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as successes
         FROM decisions
         WHERE agent_id = ? AND account_id = ? AND created_at >= ?
           AND outcome_recorded_at IS NOT NULL`
      )
      .bind(id, accountId, now7d)
      .first<{ total: number; successes: number }>();

    const stats30d = await this.db
      .prepare(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as successes
         FROM decisions
         WHERE agent_id = ? AND account_id = ? AND created_at >= ?
           AND outcome_recorded_at IS NOT NULL`
      )
      .bind(id, accountId, now30d)
      .first<{ total: number; successes: number }>();

    const topTypes = await this.db
      .prepare(
        `SELECT decision_type as type, COUNT(*) as count
         FROM decisions
         WHERE agent_id = ? AND account_id = ?
         GROUP BY decision_type
         ORDER BY count DESC
         LIMIT 5`
      )
      .bind(id, accountId)
      .all<{ type: string; count: number }>();

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

  /**
   * Update agent metadata.
   */
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

    await this.db
      .prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ? AND account_id = ?`)
      .bind(...binds)
      .run();

    return this.getAgent(id, accountId);
  }

  /**
   * Archive (soft delete) an agent.
   */
  async archiveAgent(id: string, accountId: string): Promise<boolean> {
    const res = await this.db
      .prepare(`UPDATE agents SET status = 'archived', updated_at = ? WHERE id = ? AND account_id = ? AND status != 'archived'`)
      .bind(now(), id, accountId)
      .run();
    return (res.meta?.changes || 0) > 0;
  }

  /**
   * Update agent stats from decisions table. Called from cron or commit handler.
   */
  async updateAgentStats(agentId: string): Promise<void> {
    await this.db
      .prepare(
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
      )
      .bind(agentId, agentId, agentId, now(), agentId)
      .run();
  }

  /**
   * Resolve agent from API key hash. For agent-scoped auth.
   */
  async getAgentByKeyHash(keyHash: string): Promise<Agent | null> {
    return this.db
      .prepare(
        `SELECT id, account_id, name, role, specialty, avatar_url, status,
                total_decisions, success_rate, last_active_at, created_at, updated_at
         FROM agents WHERE api_key_hash = ? AND status = 'active'`
      )
      .bind(keyHash)
      .first<Agent>();
  }
}
