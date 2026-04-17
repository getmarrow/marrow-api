/**
 * Feature 2: Session-Aware Auto-Commit
 * Prevents orphaned decisions when agents forget to commit.
 * C1: All queries scoped to accountId.
 */

export class SessionService {
  constructor(private db: D1Database) {}

  /**
   * autoCommitStale: Find decisions older than threshold with no outcome recorded.
   * Called from scheduled cron. Returns count of auto-committed decisions.
   * @param accountId - Optional. If provided, only process this account. If undefined, process all.
   * @param thresholdMinutes - Default 30 minutes of inactivity.
   */
  async autoCommitStale(accountId?: string, thresholdMinutes: number = 30): Promise<number> {
    // Clamp threshold to sane bounds (5 min to 24 hours)
    const safeThreshold = Math.max(5, Math.min(thresholdMinutes, 1440));
    let query = `
      SELECT id FROM decisions
      WHERE outcome_recorded_at IS NULL
        AND auto_committed = 0
        AND created_at < datetime('now', ?)
    `;
    const params: string[] = [`-${safeThreshold} minutes`];

    if (accountId) {
      query += ' AND account_id = ?';
      params.push(accountId);
    }

    // Batch limit to avoid runaway writes in cron
    query += ' LIMIT 200';
    const rows = await this.db.prepare(query).bind(...params).all<{ id: string }>();

    let count = 0;
    for (const row of rows.results || []) {
      const ts = new Date().toISOString();
      // M2 fix: Use outcome_success = NULL (unknown) instead of 0 (failed)
      // so auto-committed decisions don't pollute failure statistics
      const result = await this.db.prepare(`
        UPDATE decisions
        SET outcome_recorded_at = ?,
            outcome_success = NULL,
            outcome_details = ?,
            auto_committed = 1,
            updated_at = ?
        WHERE id = ? AND auto_committed = 0
      `).bind(ts, JSON.stringify({ reason: 'auto-committed: session inactive' }), ts, row.id).run();

      if ((result.meta?.changes ?? 0) > 0) count++;
    }

    return count;
  }

  /**
   * endSession: Commit any open decisions for a session.
   * Called from POST /v1/agent/session/end endpoint.
   * @param sessionId - Session to end
   * @param accountId - Account (from auth)
   * @param autoCommitOpen - Whether to auto-commit uncommitted decisions. Defaults to false to avoid silent writes.
   */
  async endSession(
    sessionId: string,
    accountId: string,
    autoCommitOpen: boolean = false
  ): Promise<{ committed: number; openDecisionId: string | null }> {
    let committed = 0;
    let openDecisionId: string | null = null;

    if (autoCommitOpen) {
      const open = await this.db.prepare(`
        SELECT id FROM decisions
        WHERE session_id = ? AND account_id = ? AND outcome_recorded_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      `).bind(sessionId, accountId).first<{ id: string }>();

      if (open) {
        openDecisionId = open.id;
        const ts = new Date().toISOString();
        // M2 fix: Use outcome_success = NULL (unknown) instead of 0 (failed)
        await this.db.prepare(`
          UPDATE decisions
          SET outcome_recorded_at = ?,
              outcome_success = NULL,
              outcome_details = ?,
              auto_committed = 1,
              updated_at = ?
          WHERE id = ?
        `).bind(ts, JSON.stringify({ reason: 'session ended' }), ts, open.id).run();
        committed = 1;
      }
    }

    return { committed, openDecisionId };
  }

  /**
   * getOpenDecisionForSession: Find an uncommitted decision for a session.
   */
  async getOpenDecisionForSession(sessionId: string, accountId: string): Promise<string | null> {
    const row = await this.db.prepare(`
      SELECT id FROM decisions
      WHERE session_id = ? AND account_id = ? AND outcome_recorded_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).bind(sessionId, accountId).first<{ id: string }>();
    return row?.id || null;
  }
}
