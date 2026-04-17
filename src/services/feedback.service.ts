/**
 * Tier 3: Outcome Feedback Service
 * Record, retrieve, and analyze decision outcomes
 */

import { uuid, now } from '../utils/crypto';
import { AuditService } from './audit.service';

export interface Outcome {
  id: string;
  decision_id: string;
  account_id: string;
  success: boolean;
  feedback?: string;
  details?: Record<string, unknown>;
  recorded_at: string;
  created_at: string;
}

export interface SuccessMetrics {
  decision_type: string;
  total_outcomes: number;
  successful: number;
  success_rate: number;
  avg_feedback_length: number;
}

export class FeedbackService {
  private audit: AuditService;

  constructor(private db: D1Database) {
    this.audit = new AuditService(db);
  }

  async recordOutcome(
    decisionId: string,
    accountId: string,
    success: boolean,
    feedback?: string,
    details?: Record<string, unknown>
  ): Promise<Outcome> {
    // Verify decision ownership
    const decision = await this.db
      .prepare('SELECT account_id FROM decisions WHERE id = ? LIMIT 1')
      .bind(decisionId)
      .first<{ account_id: string }>();

    if (!decision || decision.account_id !== accountId) {
      throw new Error('Decision not found or unauthorized');
    }

    // Check for duplicate outcome
    const existing = await this.db
      .prepare('SELECT id FROM outcomes WHERE decision_id = ? AND account_id = ? LIMIT 1')
      .bind(decisionId, accountId)
      .first<{ id: string }>();

    if (existing) {
      throw new Error('Outcome already recorded for this decision');
    }

    const id = uuid();
    const ts = now();

    await this.db
      .prepare(
        `INSERT INTO outcomes (id, decision_id, account_id, success, feedback, details, recorded_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        decisionId,
        accountId,
        success ? 1 : 0,
        feedback || null,
        details ? JSON.stringify(details) : null,
        ts,
        ts
      )
      .run();

    // Update outcome_success on decisions table so analytics can track success rate
    await this.db
      .prepare('UPDATE decisions SET outcome_success = ?, outcome_recorded_at = ? WHERE id = ? AND account_id = ?')
      .bind(success ? 1 : 0, ts, decisionId, accountId)
      .run();

    // Audit
    await this.audit.log(accountId, 'RECORD_OUTCOME', 'decision', decisionId, { success, feedback_provided: !!feedback });

    return {
      id,
      decision_id: decisionId,
      account_id: accountId,
      success,
      feedback,
      details,
      recorded_at: ts,
      created_at: ts,
    };
  }

  async getOutcome(decisionId: string, accountId: string): Promise<Outcome | null> {
    const row = await this.db
      .prepare('SELECT * FROM outcomes WHERE decision_id = ? AND account_id = ? LIMIT 1')
      .bind(decisionId, accountId)
      .first<Record<string, unknown>>();

    if (!row) return null;
    return this.rowToOutcome(row);
  }

  async getOutcomeHistory(accountId: string, limit = 50, offset = 0): Promise<Outcome[]> {
    const rows = await this.db
      .prepare('SELECT * FROM outcomes WHERE account_id = ? ORDER BY recorded_at DESC LIMIT ? OFFSET ?')
      .bind(accountId, limit, offset)
      .all<Record<string, unknown>>();

    return (rows.results || []).map(r => this.rowToOutcome(r));
  }

  async getSuccessMetrics(accountId: string, decisionType?: string): Promise<SuccessMetrics[]> {
    let sql = `
      SELECT 
        d.decision_type,
        COUNT(o.id) as total_outcomes,
        SUM(CASE WHEN o.success = 1 THEN 1 ELSE 0 END) as successful,
        AVG(CASE WHEN o.success = 1 THEN 1 ELSE 0 END) as success_rate,
        AVG(LENGTH(COALESCE(o.feedback, ''))) as avg_feedback_length
      FROM outcomes o
      JOIN decisions d ON o.decision_id = d.id
      WHERE o.account_id = ?
    `;

    const params: unknown[] = [accountId];

    if (decisionType) {
      sql += ' AND d.decision_type = ?';
      params.push(decisionType);
    }

    sql += ' GROUP BY d.decision_type';

    const rows = await this.db.prepare(sql).bind(...params).all<Record<string, unknown>>();

    return (rows.results || []).map(r => ({
      decision_type: String(r.decision_type),
      total_outcomes: Number(r.total_outcomes),
      successful: Number(r.successful),
      success_rate: Number(r.success_rate),
      avg_feedback_length: Number(r.avg_feedback_length),
    }));
  }

  async calculateSuccessRate(accountId: string, decisionType?: string): Promise<number> {
    let sql = `
      SELECT 
        COALESCE(AVG(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as rate
      FROM outcomes o
      JOIN decisions d ON o.decision_id = d.id
      WHERE o.account_id = ?
    `;

    const params: unknown[] = [accountId];

    if (decisionType) {
      sql += ' AND d.decision_type = ?';
      params.push(decisionType);
    }

    const result = await this.db.prepare(sql).bind(...params).first<{ rate: number }>();
    return result?.rate || 0;
  }

  private rowToOutcome(row: Record<string, unknown>): Outcome {
    return {
      id: String(row.id),
      decision_id: String(row.decision_id),
      account_id: String(row.account_id),
      success: Boolean(row.success),
      feedback: row.feedback ? String(row.feedback) : undefined,
      details: row.details ? JSON.parse(String(row.details)) : undefined,
      recorded_at: String(row.recorded_at),
      created_at: String(row.created_at),
    };
  }
}
