/**
 * Tier 10: Priority Queue Service
 * Rank decisions by impact, urgency, and community value
 */

import { uuid, now } from '../utils/crypto';

export interface DecisionPriority {
  id: string;
  decision_id: string;
  account_id: string;
  score: number;
  urgency: 'low' | 'normal' | 'high' | 'critical';
  impact: number;
  effective_at: string;
  expires_at?: string;
  updated_at: string;
}

export class PriorityService {
  constructor(private db: D1Database) {}

  async calculatePriority(
    decisionId: string,
    accountId: string,
    urgency: 'low' | 'normal' | 'high' | 'critical' = 'normal',
    impact = 0.5
  ): Promise<DecisionPriority> {
    const urgencyScores = { low: 0.2, normal: 0.5, high: 0.8, critical: 1.0 };
    const score = (urgencyScores[urgency] + impact) / 2;
    const ts = now();
    const id = uuid();

    const existing = await this.db
      .prepare('SELECT id FROM decision_priority WHERE decision_id = ? AND account_id = ? LIMIT 1')
      .bind(decisionId, accountId)
      .first<{ id: string }>();

    if (existing) {
      await this.db
        .prepare(
          `UPDATE decision_priority SET score = ?, urgency = ?, impact = ?, updated_at = ? WHERE id = ?`
        )
        .bind(score, urgency, impact, ts, existing.id)
        .run();
      return this.getPriority(decisionId, accountId) as Promise<DecisionPriority>;
    }

    await this.db
      .prepare(
        `INSERT INTO decision_priority (id, decision_id, account_id, score, urgency, impact, effective_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, decisionId, accountId, score, urgency, impact, ts, ts)
      .run();

    return { id, decision_id: decisionId, account_id: accountId, score, urgency, impact, effective_at: ts, updated_at: ts };
  }

  async getPriority(decisionId: string, accountId: string): Promise<DecisionPriority | null> {
    const row = await this.db
      .prepare('SELECT * FROM decision_priority WHERE decision_id = ? AND account_id = ? LIMIT 1')
      .bind(decisionId, accountId)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return this.rowToPriority(row);
  }

  async getQueueByPriority(accountId: string, limit = 50): Promise<DecisionPriority[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM decision_priority WHERE account_id = ? AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY score DESC LIMIT ?`
      )
      .bind(accountId, limit)
      .all<Record<string, unknown>>();
    return (rows.results || []).map(r => this.rowToPriority(r));
  }

  async getQueueStatus(accountId: string): Promise<{ total: number; high_priority: number; avg_score: number; last_recalc: string }> {
    const status = await this.db
      .prepare('SELECT * FROM queue_status WHERE account_id = ? LIMIT 1')
      .bind(accountId)
      .first<Record<string, unknown>>();

    if (!status) {
      return { total: 0, high_priority: 0, avg_score: 0, last_recalc: now() };
    }

    return {
      total: Number(status.total_decisions),
      high_priority: Number(status.high_priority_count),
      avg_score: Number(status.avg_score),
      last_recalc: String(status.last_recalc),
    };
  }

  async recalculateQueue(accountId: string): Promise<void> {
    const priorities = await this.db
      .prepare('SELECT COUNT(*) as total, SUM(CASE WHEN score > 0.7 THEN 1 ELSE 0 END) as high_pri, AVG(score) as avg FROM decision_priority WHERE account_id = ?')
      .bind(accountId)
      .first<{ total: number; high_pri: number; avg: number }>();

    const existing = await this.db
      .prepare('SELECT id FROM queue_status WHERE account_id = ? LIMIT 1')
      .bind(accountId)
      .first<{ id: string }>();

    const ts = now();
    if (existing) {
      await this.db
        .prepare(
          `UPDATE queue_status SET total_decisions = ?, high_priority_count = ?, avg_score = ?, last_recalc = ? WHERE account_id = ?`
        )
        .bind(priorities?.total || 0, priorities?.high_pri || 0, priorities?.avg || 0.5, ts, accountId)
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO queue_status (account_id, total_decisions, high_priority_count, avg_score, last_recalc) VALUES (?, ?, ?, ?, ?)`
        )
        .bind(accountId, priorities?.total || 0, priorities?.high_pri || 0, priorities?.avg || 0.5, ts)
        .run();
    }
  }

  private rowToPriority(row: Record<string, unknown>): DecisionPriority {
    return {
      id: String(row.id),
      decision_id: String(row.decision_id),
      account_id: String(row.account_id),
      score: Number(row.score),
      urgency: String(row.urgency) as 'low' | 'normal' | 'high' | 'critical',
      impact: Number(row.impact),
      effective_at: String(row.effective_at),
      expires_at: row.expires_at ? String(row.expires_at) : undefined,
      updated_at: String(row.updated_at),
    };
  }
}
