/**
 * Feature 6: Impact Quantification — "Saves" Metric
 * Track when Marrow's warnings actually prevented failures.
 * C1: All queries scoped to accountId.
 */
import { Save } from '../types';
import { uuid } from '../utils/crypto';

export class ImpactService {
  constructor(private db: D1Database) {}

  /**
   * recordPotentialSave: Called from think() handler when a HIGH-severity
   * warning or insight is returned. Stores the potential save with confirmed=0.
   */
  async recordPotentialSave(
    accountId: string,
    decisionId: string,
    warningType: string,
    warningMessage: string
  ): Promise<string> {
    const id = uuid();
    await this.db.prepare(`
      INSERT INTO saves (id, account_id, decision_id, warning_type, warning_message, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).bind(id, accountId, decisionId, warningType, warningMessage).run();
    return id;
  }

  /**
   * confirmSave: Called from commit() handler.
   * If success=true and there's a pending save for this decision, mark confirmed=1.
   */
  async confirmSave(accountId: string, decisionId: string, success: boolean): Promise<void> {
    if (!success) return; // Only confirm saves on success

    await this.db.prepare(`
      UPDATE saves
      SET confirmed_save = 1,
          subsequent_decision_id = ?,
          subsequent_success = 1
      WHERE decision_id = ? AND account_id = ? AND confirmed_save = 0
    `).bind(decisionId, decisionId, accountId).run();
  }

  /**
   * getSavesCount: Total confirmed saves for an account or one agent within a time window.
   */
  async getSavesCount(accountId: string, since?: string, agentId?: string | null): Promise<{ thisWeek: number; total: number }> {
    const weekAgo = since || new Date(Date.now() - 7 * 86400000).toISOString();

    if (agentId) {
      const thisWeek = await this.db.prepare(`
        SELECT COUNT(*) as c
        FROM saves s
        JOIN decisions d ON d.id = s.decision_id AND d.account_id = s.account_id
        WHERE s.account_id = ? AND s.confirmed_save = 1 AND s.created_at > ?
          AND (d.agent_id = ? OR d.session_id = ?)
      `).bind(accountId, weekAgo, agentId, agentId).first<{ c: number }>();

      const total = await this.db.prepare(`
        SELECT COUNT(*) as c
        FROM saves s
        JOIN decisions d ON d.id = s.decision_id AND d.account_id = s.account_id
        WHERE s.account_id = ? AND s.confirmed_save = 1
          AND (d.agent_id = ? OR d.session_id = ?)
      `).bind(accountId, agentId, agentId).first<{ c: number }>();

      return {
        thisWeek: thisWeek?.c || 0,
        total: total?.c || 0,
      };
    }

    const thisWeek = await this.db.prepare(`
      SELECT COUNT(*) as c FROM saves
      WHERE account_id = ? AND confirmed_save = 1 AND created_at > ?
    `).bind(accountId, weekAgo).first<{ c: number }>();

    const total = await this.db.prepare(`
      SELECT COUNT(*) as c FROM saves WHERE account_id = ? AND confirmed_save = 1
    `).bind(accountId).first<{ c: number }>();

    return {
      thisWeek: thisWeek?.c || 0,
      total: total?.c || 0,
    };
  }

  /**
   * getSavesDetails: Recent confirmed saves with context for dashboard.
   */
  async getSavesDetails(accountId: string, limit: number = 10): Promise<Array<{
    action: string;
    warning_given: string;
    outcome: string;
    saved_at: string;
  }>> {
    const rows = await this.db.prepare(`
      SELECT s.*, d.outcome as decision_outcome, d.context
      FROM saves s
      JOIN decisions d ON s.decision_id = d.id
      WHERE s.account_id = ? AND s.confirmed_save = 1
      ORDER BY s.created_at DESC
      LIMIT ?
    `).bind(accountId, limit).all<{
      warning_message: string; created_at: string; decision_outcome: string; context: string;
    }>();

    return (rows.results || []).map(r => {
      // Extract action from context (safe, non-PII)
      let action = 'agent action';
      try {
        const ctx = JSON.parse(r.context);
        action = typeof ctx.action === 'string' ? ctx.action.slice(0, 80) :
          typeof ctx.description === 'string' ? ctx.description.slice(0, 80) : action;
      } catch { /* use default */ }

      return {
        action,
        warning_given: r.warning_message.slice(0, 200),
        outcome: r.decision_outcome?.slice(0, 200) || 'success',
        saved_at: r.created_at,
      };
    });
  }

  /**
   * getPendingSave: Check if a decision has a pending save entry.
   */
  async getPendingSave(decisionId: string, accountId: string): Promise<Save | null> {
    const row = await this.db.prepare(`
      SELECT * FROM saves WHERE decision_id = ? AND account_id = ? AND confirmed_save = 0 LIMIT 1
    `).bind(decisionId, accountId).first<Record<string, unknown>>();
    if (!row) return null;
    return {
      id: String(row.id),
      account_id: String(row.account_id),
      decision_id: String(row.decision_id),
      warning_type: String(row.warning_type),
      warning_message: String(row.warning_message),
      subsequent_decision_id: row.subsequent_decision_id ? String(row.subsequent_decision_id) : null,
      subsequent_success: row.subsequent_success as number | null,
      confirmed_save: Boolean(row.confirmed_save),
      created_at: String(row.created_at),
    };
  }
}
