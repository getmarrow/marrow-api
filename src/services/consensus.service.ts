/**
 * Tier 13: Hive Consensus Service
 * Aggregate agent votes on decisions
 */

import { uuid, now } from '../utils/crypto';

export interface ConsensusAnalysis {
  decision_id: string;
  total_votes: number;
  agree_count: number;
  disagree_count: number;
  abstain_count: number;
  consensus_ratio: number;
}

export class ConsensusService {
  constructor(private db: D1Database) {}

  async recordVote(decisionId: string, accountId: string, voteType: 'agree' | 'disagree' | 'abstain', reasoning?: string): Promise<{ vote_id: string }> {
    const decision = await this.db.prepare(
      "SELECT id FROM decisions WHERE id = ? AND (account_id = ? OR visibility IN ('shared', 'hive')) LIMIT 1"
    ).bind(decisionId, accountId).first<{ id: string }>();
    if (!decision) throw new Error('Decision not found');

    const id = uuid();
    const ts = now();

    const agrees = voteType === 'agree' ? 1 : 0;
    await this.db
      .prepare(
        `INSERT INTO consensus_votes (id, decision_id, voting_agent_id, agrees, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(id, decisionId, accountId, agrees, 0.9, ts)
      .run();

    await this.calculateConsensus(decisionId);

    return { vote_id: id };
  }

  async calculateConsensus(decisionId: string): Promise<ConsensusAnalysis> {
    const votes = await this.db
      .prepare(
        `SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN agrees = 1 THEN 1 ELSE 0 END) as agrees,
          SUM(CASE WHEN agrees = 0 THEN 1 ELSE 0 END) as disagrees,
          0 as abstains
         FROM consensus_votes WHERE decision_id = ?`
      )
      .bind(decisionId)
      .first<{ total: number; agrees: number; disagrees: number; abstains: number }>();

    const total = votes?.total || 0;
    const agreeCount = votes?.agrees || 0;
    const disagreeCount = votes?.disagrees || 0;
    const abstainCount = votes?.abstains || 0;
    const consensusRatio = total === 0 ? 0 : agreeCount / total;

    const id = uuid();
    const ts = now();

    const existing = await this.db
      .prepare('SELECT id FROM consensus_analysis WHERE decision_id = ? LIMIT 1')
      .bind(decisionId)
      .first<{ id: string }>();

    if (existing) {
      await this.db
        .prepare(
          `UPDATE consensus_analysis SET total_votes = ?, agree_count = ?, disagree_count = ?, abstain_count = ?, consensus_ratio = ?, analyzed_at = ?
           WHERE decision_id = ?`
        )
        .bind(total, agreeCount, disagreeCount, abstainCount, consensusRatio, ts, decisionId)
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO consensus_analysis (id, decision_id, total_votes, agree_count, disagree_count, abstain_count, consensus_ratio, analyzed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, decisionId, total, agreeCount, disagreeCount, abstainCount, consensusRatio, ts)
        .run();
    }

    return {
      decision_id: decisionId,
      total_votes: total,
      agree_count: agreeCount,
      disagree_count: disagreeCount,
      abstain_count: abstainCount,
      consensus_ratio: consensusRatio,
    };
  }

  async getHiveConsensus(decisionType: string, limit = 50): Promise<Array<{ decision_id: string; consensus_ratio: number; total_votes: number }>> {
    const rows = await this.db
      .prepare(
        `SELECT ca.decision_id, ca.consensus_ratio, ca.total_votes 
         FROM consensus_analysis ca
         JOIN decisions d ON ca.decision_id = d.id
         WHERE d.decision_type = ? AND d.visibility IN ('shared', 'hive')
         ORDER BY ca.total_votes DESC, ca.consensus_ratio DESC LIMIT ?`
      )
      .bind(decisionType, limit)
      .all<{ decision_id: string; consensus_ratio: number; total_votes: number }>();

    return rows.results || [];
  }

  async detectDisagreement(decisionId: string, threshold = 0.3): Promise<{ detected: boolean; disagreement_level: number }> {
    const analysis = await this.db
      .prepare('SELECT total_votes, disagree_count FROM consensus_analysis WHERE decision_id = ? LIMIT 1')
      .bind(decisionId)
      .first<{ total_votes: number; disagree_count: number }>();

    if (!analysis || analysis.total_votes === 0) return { detected: false, disagreement_level: 0 };

    const disagreementLevel = analysis.disagree_count / analysis.total_votes;
    return { detected: disagreementLevel >= threshold, disagreement_level: disagreementLevel };
  }
}
