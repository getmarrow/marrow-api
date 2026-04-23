export type VelocityDirection = 'improving' | 'declining' | 'stable';

export interface VelocityMetric {
  current: number;
  previous: number;
  delta_pct: number;
  direction: VelocityDirection;
}

export class VelocityService {
  constructor(private db: D1Database) {}

  async getAttemptsPerSuccess(
    accountId: string,
    periodDays = 7,
    agentKey?: string
  ): Promise<VelocityMetric> {
    const [current, previous] = await Promise.all([
      this.queryAttemptsPerSuccess(accountId, periodDays, 0, agentKey),
      this.queryAttemptsPerSuccess(accountId, periodDays, periodDays, agentKey),
    ]);

    return this.buildMetric(current, previous, true);
  }

  async getTimeToSuccess(
    accountId: string,
    periodDays = 7,
    agentKey?: string
  ): Promise<VelocityMetric> {
    const [current, previous] = await Promise.all([
      this.queryMedianTimeToSuccess(accountId, periodDays, 0, agentKey),
      this.queryMedianTimeToSuccess(accountId, periodDays, periodDays, agentKey),
    ]);

    return this.buildMetric(current, previous, true);
  }

  async getDriftRate(
    accountId: string,
    periodDays = 7,
    agentKey?: string
  ): Promise<VelocityMetric> {
    const [current, previous] = await Promise.all([
      this.queryDriftRate(accountId, periodDays, 0, agentKey),
      this.queryDriftRate(accountId, periodDays, periodDays, agentKey),
    ]);

    return this.buildMetric(current, previous, true);
  }

  private buildMetric(current: number, previous: number, lowerIsBetter: boolean): VelocityMetric {
    if (current === 0 && previous === 0) {
      return { current: 0, previous: 0, delta_pct: 0, direction: 'stable' };
    }

    const deltaPct = previous === 0
      ? 0
      : Number((((current - previous) / previous) * 100).toFixed(2));

    let direction: VelocityDirection = 'stable';
    if (current !== previous) {
      const improving = lowerIsBetter ? current < previous : current > previous;
      direction = improving ? 'improving' : 'declining';
    }

    return {
      current: Number(current.toFixed(2)),
      previous: Number(previous.toFixed(2)),
      delta_pct: deltaPct,
      direction,
    };
  }

  private async queryAttemptsPerSuccess(
    accountId: string,
    periodDays: number,
    previousOffsetDays = 0,
    agentKey?: string
  ): Promise<number> {
    const bindings: (string | number)[] = [accountId, `-${periodDays + previousOffsetDays} days`];
    const endClause = previousOffsetDays > 0 ? ` AND created_at <= datetime('now', ?)` : '';
    const agentClause = agentKey ? ' AND COALESCE(agent_id, session_id) = ?' : '';
    const groupKey = agentKey ? 'COALESCE(agent_id, session_id)' : 'session_id';
    if (previousOffsetDays > 0) bindings.push(`-${previousOffsetDays} days`);
    if (agentKey) bindings.push(agentKey);

    const row = await this.db.prepare(`
      SELECT AVG(CAST(total AS REAL) / successes) AS avg_attempts
      FROM (
        SELECT
          ${groupKey} AS entity_key,
          COUNT(*) AS total,
          SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) AS successes
        FROM decisions
        WHERE account_id = ?
          AND created_at > datetime('now', ?)
          ${endClause}
          ${agentClause}
        GROUP BY ${groupKey}
        HAVING successes > 0
      )
    `).bind(...bindings).first<{ avg_attempts: number | null }>();

    return row?.avg_attempts ? Number(row.avg_attempts) : 0;
  }

  private async queryMedianTimeToSuccess(
    accountId: string,
    periodDays: number,
    previousOffsetDays = 0,
    agentKey?: string
  ): Promise<number> {
    const countBindings: (string | number)[] = [accountId, `-${periodDays + previousOffsetDays} days`];
    const endClause = previousOffsetDays > 0 ? ` AND created_at <= datetime('now', ?)` : '';
    const agentClause = agentKey ? ' AND COALESCE(agent_id, session_id) = ?' : '';
    if (previousOffsetDays > 0) countBindings.push(`-${previousOffsetDays} days`);
    if (agentKey) countBindings.push(agentKey);

    const countRow = await this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM decisions
      WHERE account_id = ?
        AND outcome_success = 1
        AND outcome_recorded_at IS NOT NULL
        AND created_at IS NOT NULL
        AND created_at > datetime('now', ?)
        ${endClause}
        ${agentClause}
    `).bind(...countBindings).first<{ total: number }>();

    const total = countRow?.total || 0;
    if (total === 0) return 0;

    const medianBindings: (string | number)[] = [accountId, `-${periodDays + previousOffsetDays} days`];
    if (previousOffsetDays > 0) medianBindings.push(`-${previousOffsetDays} days`);
    if (agentKey) medianBindings.push(agentKey);
    medianBindings.push(Math.floor(total / 2));

    const row = await this.db.prepare(`
      SELECT CAST((julianday(outcome_recorded_at) - julianday(created_at)) * 86400 AS INTEGER) AS delta_seconds
      FROM decisions
      WHERE account_id = ?
        AND outcome_success = 1
        AND outcome_recorded_at IS NOT NULL
        AND created_at IS NOT NULL
        AND created_at > datetime('now', ?)
        ${endClause}
        ${agentClause}
      ORDER BY delta_seconds
      LIMIT 1 OFFSET ?
    `).bind(...medianBindings).first<{ delta_seconds: number | null }>();

    return row?.delta_seconds ? Number(row.delta_seconds) : 0;
  }

  private async queryDriftRate(
    accountId: string,
    periodDays: number,
    previousOffsetDays = 0,
    agentKey?: string
  ): Promise<number> {
    const bindings: (string | number)[] = [accountId, `-${periodDays + previousOffsetDays} days`];
    const endClause = previousOffsetDays > 0 ? ` AND created_at <= datetime('now', ?)` : '';
    const agentClause = agentKey ? ' AND COALESCE(agent_id, session_id) = ?' : '';
    if (previousOffsetDays > 0) bindings.push(`-${previousOffsetDays} days`);
    if (agentKey) bindings.push(agentKey);

    const row = await this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN cluster_id IS NULL THEN 1 ELSE 0 END) AS drift_count
      FROM decisions
      WHERE account_id = ?
        AND created_at > datetime('now', ?)
        ${endClause}
        ${agentClause}
    `).bind(...bindings).first<{ total: number; drift_count: number | null }>();

    const total = row?.total || 0;
    const driftCount = row?.drift_count || 0;
    if (total === 0) return 0;

    return (driftCount / total) * 100;
  }
}
