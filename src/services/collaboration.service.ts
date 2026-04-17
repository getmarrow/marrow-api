/**
 * Tier 4: Multi-Agent Collaboration
 * Tier 6: Causal Reasoning Graphs
 * Tier 9: Cross-Domain Transfer Learning
 * Tier 14: Hive Consensus
 */
import { DecisionShare, CausalityEdge, Lesson, ConsensusVote } from '../types';
import { uuid, now } from '../utils/crypto';
import { AuditService } from './audit.service';

export class CollaborationService {
  private audit: AuditService;

  constructor(private db: D1Database) {
    this.audit = new AuditService(db);
  }

  // ====== TIER 4: COLLABORATION ======

  async shareDecision(decisionId: string, sharedBy: string, sharedWith: string, trustScore: number): Promise<DecisionShare> {
    if (trustScore < 0 || trustScore > 1) throw new Error('Trust score must be between 0 and 1');

    const decision = await this.db.prepare('SELECT id FROM decisions WHERE id = ? AND account_id = ?').bind(decisionId, sharedBy).first();
    if (!decision) throw new Error('Decision not found or not owned');

    const target = await this.db.prepare('SELECT id FROM accounts WHERE id = ?').bind(sharedWith).first();
    if (!target) throw new Error('Target account not found');

    const id = uuid();
    const ts = now();

    await this.db.prepare(
      'INSERT INTO decision_shares (id, decision_id, shared_by_account_id, shared_with_account_id, trust_score, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, decisionId, sharedBy, sharedWith, trustScore, ts).run();

    await this.db.prepare('UPDATE decisions SET visibility = ? WHERE id = ?').bind('shared', decisionId).run();
    await this.audit.log(sharedBy, 'SHARE', 'decision', decisionId, { shared_with: sharedWith, trust_score: trustScore });

    return { id, decision_id: decisionId, shared_by_account_id: sharedBy, shared_with_account_id: sharedWith, trust_score: trustScore, created_at: ts };
  }

  async getSharedDecisions(accountId: string, limit = 50, offset = 0): Promise<unknown[]> {
    const res = await this.db.prepare(`
      SELECT d.*, ds.trust_score, ds.shared_by_account_id
      FROM decisions d
      JOIN decision_shares ds ON d.id = ds.decision_id
      WHERE ds.shared_with_account_id = ?
      ORDER BY d.created_at DESC LIMIT ? OFFSET ?
    `).bind(accountId, limit, offset).all<Record<string, unknown>>();

    return (res.results || []).map(r => ({ ...r, context: JSON.parse(String(r.context)) }));
  }

  // ====== TIER 6: CAUSAL REASONING ======

  async addCausalityEdge(fromId: string, toId: string, reasoning: string, accountId: string): Promise<CausalityEdge> {
    const from = await this.db.prepare('SELECT id FROM decisions WHERE id = ? AND account_id = ?').bind(fromId, accountId).first();
    const to = await this.db.prepare('SELECT id FROM decisions WHERE id = ? AND account_id = ?').bind(toId, accountId).first();
    if (!from || !to) throw new Error('One or both decisions not found');

    if (await this.detectCycle(toId, fromId)) throw new Error('Cycle detected in causality graph');

    const id = uuid();
    const ts = now();
    await this.db.prepare(
      'INSERT INTO causality_edges (id, from_decision_id, to_decision_id, reasoning, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, fromId, toId, reasoning, ts).run();

    await this.audit.log(accountId, 'CAUSALITY_LINK', 'decision', toId, { from: fromId });

    return { id, from_decision_id: fromId, to_decision_id: toId, reasoning, created_at: ts };
  }

  async getCausalityGraph(decisionId: string, accountId: string) {
    const causes = await this.db.prepare(`
      SELECT ce.*, d.decision_type FROM causality_edges ce
      JOIN decisions d ON ce.from_decision_id = d.id
      WHERE ce.to_decision_id = ? AND d.account_id = ?
    `).bind(decisionId, accountId).all<Record<string, unknown>>();

    const effects = await this.db.prepare(`
      SELECT ce.*, d.decision_type FROM causality_edges ce
      JOIN decisions d ON ce.to_decision_id = d.id
      WHERE ce.from_decision_id = ? AND d.account_id = ?
    `).bind(decisionId, accountId).all<Record<string, unknown>>();

    return {
      decision_id: decisionId,
      direct_causes: (causes.results || []).length,
      downstream_effects: (effects.results || []).length,
      causes: causes.results || [],
      effects: effects.results || [],
    };
  }

  private async detectCycle(startId: string, targetId: string, visited = new Set<string>()): Promise<boolean> {
    if (startId === targetId) return true;
    if (visited.has(startId)) return false;
    visited.add(startId);

    const edges = await this.db.prepare('SELECT to_decision_id FROM causality_edges WHERE from_decision_id = ?').bind(startId).all<{ to_decision_id: string }>();
    for (const edge of edges.results || []) {
      if (await this.detectCycle(edge.to_decision_id, targetId, visited)) return true;
    }
    return false;
  }

  // ====== TIER 9: TRANSFER LEARNING ======

  async createLesson(accountId: string, title: string, content: string, domainTags?: string[]): Promise<Lesson> {
    const id = uuid();
    const ts = now();
    await this.db.prepare(
      'INSERT INTO lessons (id, account_id, title, content, domain_tags, transferability_score, is_published, publisher_reputation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0.5, 0, 0, ?, ?)'
    ).bind(id, accountId, title, content, domainTags ? JSON.stringify(domainTags) : null, ts, ts).run();

    await this.audit.log(accountId, 'CREATE', 'lesson', id, { title });

    return { id, account_id: accountId, title, content, domain_tags: domainTags, transferability_score: 0.5, is_published: false, publisher_reputation: 0, created_at: ts, updated_at: ts };
  }

  async getTransferableLessons(fromDomain: string, toDomain: string, limit = 10) {
    const res = await this.db.prepare(`
      SELECT l.*,
        CASE
          WHEN domain_tags LIKE ? THEN 0.9
          WHEN domain_tags LIKE ? THEN 0.7
          ELSE 0.3
        END as calc_transfer
      FROM lessons l
      WHERE (l.domain_tags LIKE ? OR l.is_published = 1)
      ORDER BY calc_transfer DESC, l.created_at DESC LIMIT ?
    `).bind(`%${fromDomain}%`, `%${toDomain}%`, `%${fromDomain}%`, limit).all<Record<string, unknown>>();

    return (res.results || []).map(r => ({
      ...r,
      domain_tags: r.domain_tags ? JSON.parse(String(r.domain_tags)) : [],
      transferability_score: r.calc_transfer,
    }));
  }

  // ====== TIER 14: HIVE CONSENSUS ======

  async recordConsensusVote(decisionId: string, votingAgentId: string, agrees: boolean): Promise<ConsensusVote> {
    const decision = await this.db.prepare('SELECT id FROM decisions WHERE id = ?').bind(decisionId).first();
    if (!decision) throw new Error('Decision not found');

    const id = uuid();
    const ts = now();

    // Get current vote count to calculate boost
    const voteCount = await this.db.prepare('SELECT COUNT(*) as cnt FROM consensus_votes WHERE decision_id = ? AND agrees = 1').bind(decisionId).first<{ cnt: number }>();
    const agreeCount = (voteCount?.cnt || 0) + (agrees ? 1 : 0);
    const boost = agreeCount >= 3 ? 3.0 : agreeCount >= 2 ? 2.0 : 1.0;

    await this.db.prepare(
      'INSERT OR REPLACE INTO consensus_votes (id, decision_id, voting_agent_id, agrees, confidence_boost, voted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, decisionId, votingAgentId, agrees ? 1 : 0, boost, ts, ts).run();

    return { id, decision_id: decisionId, voting_agent_id: votingAgentId, agrees, confidence_boost: boost, voted_at: ts, created_at: ts };
  }

  async getHiveConsensus(decisionType: string, limit = 50) {
    const res = await this.db.prepare(`
      SELECT cv.*, d.decision_type FROM consensus_votes cv
      JOIN decisions d ON cv.decision_id = d.id
      WHERE d.decision_type = ?
      ORDER BY cv.created_at DESC LIMIT ?
    `).bind(decisionType, limit).all<Record<string, unknown>>();

    const votes = res.results || [];
    const total = votes.length;
    const agrees = votes.filter(v => v.agrees === 1).length;
    const boost = agrees >= 3 ? 3.0 : agrees >= 2 ? 2.0 : 1.0;

    return {
      decision_type: decisionType,
      total_votes: total,
      agree_count: agrees,
      agreement_percentage: total > 0 ? (agrees / total) * 100 : 0,
      confidence_boost: boost,
      voting_agents_count: new Set(votes.map(v => String(v.voting_agent_id))).size,
    };
  }
}
