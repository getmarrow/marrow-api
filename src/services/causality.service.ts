/**
 * Tier 6: Causal Reasoning Service
 * Map causality between decisions, detect cycles, calculate causal depth
 */

import { uuid, now } from '../utils/crypto';
import { AuditService } from './audit.service';

export interface CausalityEdge {
  id: string;
  from_decision_id: string;
  to_decision_id: string;
  account_id: string;
  reasoning: string;
  strength: number;
  created_at: string;
}

export interface CausalityGraph {
  nodes: { id: string; decision_type: string }[];
  edges: CausalityEdge[];
  depth: number;
}

export class CausalityService {
  private audit: AuditService;

  constructor(private db: D1Database) {
    this.audit = new AuditService(db);
  }

  async addCausalityEdge(
    fromDecisionId: string,
    toDecisionId: string,
    reasoning: string,
    accountId: string,
    strength = 1.0
  ): Promise<CausalityEdge> {
    // Verify both decisions exist and belong to account
    const from = await this.db.prepare('SELECT account_id FROM decisions WHERE id = ? LIMIT 1').bind(fromDecisionId).first<{ account_id: string }>();
    const to = await this.db.prepare('SELECT account_id FROM decisions WHERE id = ? LIMIT 1').bind(toDecisionId).first<{ account_id: string }>();

    if (!from || from.account_id !== accountId || !to || to.account_id !== accountId) {
      throw new Error('One or both decisions not found or unauthorized');
    }

    if (fromDecisionId === toDecisionId) {
      throw new Error('Cycle detected: cannot link decision to itself');
    }

    // Detect cycles using DFS
    if (await this.hasCycle(fromDecisionId, toDecisionId, accountId)) {
      throw new Error('Cycle detected: adding this edge would create a cycle');
    }

    const id = uuid();
    const ts = now();

    await this.db
      .prepare(
        `INSERT INTO causality_edges (id, from_decision_id, to_decision_id, account_id, reasoning, strength, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, fromDecisionId, toDecisionId, accountId, reasoning, strength, ts)
      .run();

    // Update stats
    await this.updateCausalityStats(toDecisionId);
    await this.updateCausalityStats(fromDecisionId);

    await this.audit.log(accountId, 'ADD_CAUSALITY', 'decision', toDecisionId, { from: fromDecisionId, reasoning });

    return {
      id,
      from_decision_id: fromDecisionId,
      to_decision_id: toDecisionId,
      account_id: accountId,
      reasoning,
      strength,
      created_at: ts,
    };
  }

  async getCausalityGraph(decisionId: string, accountId: string): Promise<CausalityGraph> {
    // Get all edges for this decision and related
    const edges = await this.db
      .prepare(`
        SELECT * FROM causality_edges 
        WHERE account_id = ? AND (from_decision_id = ? OR to_decision_id = ?)
      `)
      .bind(accountId, decisionId, decisionId)
      .all<Record<string, unknown>>();

    const edgeSet = (edges.results || []).map(r => this.rowToEdge(r));

    // Get all decision nodes
    const decisionIds = new Set<string>();
    decisionIds.add(decisionId);
    edgeSet.forEach(e => {
      decisionIds.add(e.from_decision_id);
      decisionIds.add(e.to_decision_id);
    });

    const nodeRows = await this.db
      .prepare('SELECT id, decision_type FROM decisions WHERE id IN (' + Array(decisionIds.size).fill('?').join(',') + ')')
      .bind(...Array.from(decisionIds))
      .all<Record<string, unknown>>();

    const nodes = (nodeRows.results || []).map(r => ({
      id: String(r.id),
      decision_type: String(r.decision_type),
    }));

    const depth = await this.calculateCausalDepth(decisionId, accountId);

    return { nodes, edges: edgeSet, depth };
  }

  private async calculateCausalDepth(decisionId: string, accountId: string, visited = new Set<string>()): Promise<number> {
    if (visited.has(decisionId)) return 0;
    visited.add(decisionId);

    const edges = await this.db
      .prepare('SELECT to_decision_id FROM causality_edges WHERE from_decision_id = ? AND account_id = ?')
      .bind(decisionId, accountId)
      .all<{ to_decision_id: string }>();

    if (!edges.results || edges.results.length === 0) return 0;

    const maxDepth = Math.max(
      ...(await Promise.all(
        edges.results.map(e => this.calculateCausalDepth(e.to_decision_id, accountId, new Set(visited)))
      ))
    );

    return 1 + maxDepth;
  }

  private async hasCycle(fromId: string, toId: string, accountId: string, visited = new Set<string>()): Promise<boolean> {
    if (visited.has(toId)) return true;
    visited.add(toId);

    const edges = await this.db
      .prepare('SELECT from_decision_id FROM causality_edges WHERE to_decision_id = ? AND account_id = ?')
      .bind(toId, accountId)
      .all<{ from_decision_id: string }>();

    for (const edge of edges.results || []) {
      if (edge.from_decision_id === fromId) return true;
      if (await this.hasCycle(fromId, edge.from_decision_id, accountId, new Set(visited))) return true;
    }

    return false;
  }

  private async updateCausalityStats(decisionId: string): Promise<void> {
    const incoming = await this.db
      .prepare('SELECT COUNT(*) as count FROM causality_edges WHERE to_decision_id = ?')
      .bind(decisionId)
      .first<{ count: number}>();

    const outgoing = await this.db
      .prepare('SELECT COUNT(*) as count FROM causality_edges WHERE from_decision_id = ?')
      .bind(decisionId)
      .first<{ count: number}>();

    const depth = await this.calculateCausalDepth(decisionId, decisionId);

    const existing = await this.db
      .prepare('SELECT id FROM causality_stats WHERE decision_id = ? LIMIT 1')
      .bind(decisionId)
      .first<{ id: string }>();

    const ts = now();
    if (existing) {
      await this.db
        .prepare(
          `UPDATE causality_stats SET causal_depth = ?, incoming_count = ?, outgoing_count = ?, last_updated = ?
           WHERE decision_id = ?`
        )
        .bind(depth, incoming?.count || 0, outgoing?.count || 0, ts, decisionId)
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO causality_stats (decision_id, causal_depth, incoming_count, outgoing_count, last_updated)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(decisionId, depth, incoming?.count || 0, outgoing?.count || 0, ts)
        .run();
    }
  }

  private rowToEdge(row: Record<string, unknown>): CausalityEdge {
    return {
      id: String(row.id),
      from_decision_id: String(row.from_decision_id),
      to_decision_id: String(row.to_decision_id),
      account_id: String(row.account_id),
      reasoning: String(row.reasoning),
      strength: Number(row.strength),
      created_at: String(row.created_at),
    };
  }
}
