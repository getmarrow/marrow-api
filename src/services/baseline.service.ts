/**
 * BaselineService — day-1 snapshot capture + improvement vs baseline.
 *
 * Every account+agent pair gets one baseline captured when either:
 * - 7 days have passed since their first decision (time_7d), OR
 * - 20+ decisions accumulated before 7 days elapsed (volume_20)
 *
 * Once baseline exists, all subsequent periods are compared against it
 * to surface "your agents are X% faster since onboarding" metrics.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { VelocityService } from './velocity.service';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ImprovementStatus = 'active' | 'onboarding';

export interface MetricDelta {
  baseline: number;
  current: number;
  delta_pct: number;
}

export interface ImprovementBlock {
  status: 'active';
  days_since_baseline: number;
  decisions_since_baseline: number;
  baseline_captured_at: string;
  trigger_reason: string;
  attempts_per_success: MetricDelta;
  time_to_success_seconds: MetricDelta;
  drift_rate: MetricDelta;
  success_rate: MetricDelta;
}

export interface OnboardingBlock {
  status: 'onboarding';
  days_elapsed: number;
  decisions_elapsed: number;
  days_until_time_trigger: number;
  decisions_until_volume_trigger: number;
  reason: string;
}

export type ImprovementResult = ImprovementBlock | OnboardingBlock;

// ── Helper: compute velocity metrics over a bounded window ──────────────────────
// (Mirrors VelocityService logic but scoped to an explicit date range instead
//  of rolling "last N days from now" — needed for backfill and baseline capture)

interface BaselineMetrics {
  attempts_per_success: number;
  time_to_success_seconds: number;
  drift_rate: number;
  success_rate: number;
}

function buildMetricDelta(
  baseline: number,
  current: number,
  lowerIsBetter: boolean
): MetricDelta {
  if (baseline === 0 && current === 0) {
    return { baseline: 0, current: 0, delta_pct: 0 };
  }
  const deltaPct =
    baseline === 0
      ? 0
      : Number((((current - baseline) / baseline) * 100).toFixed(2));
  return {
    baseline: Number(baseline.toFixed(2)),
    current: Number(current.toFixed(2)),
    delta_pct: deltaPct,
  };
}

// ── Service ──────────────────────────────────────────────────────────────────────────

export class BaselineService {
  constructor(private db: D1Database) {}

  // ── a) captureAccountBaselineIfEligible ──────────────────────────────────────────

  async captureAccountBaselineIfEligible(accountId: string): Promise<void> {
    // Already captured?
    const existing = await this.db
      .prepare('SELECT id FROM account_baselines WHERE account_id = ? LIMIT 1')
      .bind(accountId)
      .first<{ id: string }>();
    if (existing) return;

    const firstRow = await this.db
      .prepare('SELECT MIN(created_at) AS first_at FROM decisions WHERE account_id = ? LIMIT 1')
      .bind(accountId)
      .first<{ first_at: string | null }>();
    if (!firstRow?.first_at) return;

    const firstAt = firstRow.first_at;

    // Count decisions in the baseline window
    const countRow = await this.db
      .prepare(`
        SELECT COUNT(*) AS c FROM decisions
        WHERE account_id = ?
          AND created_at >= ?
          AND created_at <= datetime(?, '+7 days')
      `)
      .bind(accountId, firstAt, firstAt)
      .first<{ c: number }>();
    const decisionsInWindow = countRow?.c || 0;

    if (decisionsInWindow === 0) return;

    // Determine trigger
    const daysElapsed = this.daysBetween(new Date(firstAt), new Date());
    let triggerReason: 'time_7d' | 'volume_20';
    if (daysElapsed >= 7) {
      triggerReason = 'time_7d';
    } else if (decisionsInWindow >= 20) {
      triggerReason = 'volume_20';
    } else {
      // Not eligible yet — 7 days not passed AND < 20 decisions
      return;
    }

    const capturedAt = new Date().toISOString();
    const daysInWindow = Math.min(daysElapsed, 7);
    const baselineEndTs = this.baselineWindowEnd(firstAt);
    const metrics = await this.computeBaselineMetrics(accountId, firstAt, baselineEndTs);

    await this.db
      .prepare(`
        INSERT INTO account_baselines
          (id, account_id, captured_at, first_decision_at, days_in_window,
           decisions_in_window, attempts_per_success, time_to_success_seconds,
           drift_rate, success_rate, trigger_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        crypto.randomUUID(),
        accountId,
        capturedAt,
        firstAt,
        daysInWindow,
        decisionsInWindow,
        metrics.attempts_per_success,
        metrics.time_to_success_seconds,
        metrics.drift_rate,
        metrics.success_rate,
        triggerReason
      )
      .run();
  }

  // ── b) captureAgentBaselineIfEligible ─────────────────────────────────────────

  async captureAgentBaselineIfEligible(
    accountId: string,
    agentId: string
  ): Promise<void> {
    const existing = await this.db
      .prepare(
        'SELECT id FROM agent_baselines WHERE account_id = ? AND agent_id = ? LIMIT 1'
      )
      .bind(accountId, agentId)
      .first<{ id: string }>();
    if (existing) return;

    const firstRow = await this.db
      .prepare(
        'SELECT MIN(created_at) AS first_at FROM decisions WHERE account_id = ? AND COALESCE(agent_id, session_id) = ? LIMIT 1'
      )
      .bind(accountId, agentId)
      .first<{ first_at: string | null }>();
    if (!firstRow?.first_at) return;

    const firstAt = firstRow.first_at;

    const countRow = await this.db
      .prepare(`
        SELECT COUNT(*) AS c FROM decisions
        WHERE account_id = ? AND COALESCE(agent_id, session_id) = ?
          AND created_at >= ?
          AND created_at <= datetime(?, '+7 days')
      `)
      .bind(accountId, agentId, firstAt, firstAt)
      .first<{ c: number }>();
    const decisionsInWindow = countRow?.c || 0;

    if (decisionsInWindow === 0) return;

    const daysElapsed = this.daysBetween(new Date(firstAt), new Date());
    let triggerReason: 'time_7d' | 'volume_20';
    if (daysElapsed >= 7) {
      triggerReason = 'time_7d';
    } else if (decisionsInWindow >= 20) {
      triggerReason = 'volume_20';
    } else {
      return;
    }

    const capturedAt = new Date().toISOString();
    const daysInWindow = Math.min(daysElapsed, 7);
    const baselineEndTs = this.baselineWindowEnd(firstAt);
    const metrics = await this.computeBaselineMetrics(accountId, firstAt, baselineEndTs, agentId);

    await this.db
      .prepare(`
        INSERT INTO agent_baselines
          (id, account_id, agent_id, captured_at, first_decision_at, days_in_window,
           decisions_in_window, attempts_per_success, time_to_success_seconds,
           drift_rate, success_rate, trigger_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        crypto.randomUUID(),
        accountId,
        agentId,
        capturedAt,
        firstAt,
        daysInWindow,
        decisionsInWindow,
        metrics.attempts_per_success,
        metrics.time_to_success_seconds,
        metrics.drift_rate,
        metrics.success_rate,
        triggerReason
      )
      .run();
  }

  // ── c) getAccountImprovement ──────────────────────────────────────────────

  async getAccountImprovement(accountId: string): Promise<ImprovementResult> {
    const baseline = await this.db
      .prepare('SELECT * FROM account_baselines WHERE account_id = ? LIMIT 1')
      .bind(accountId)
      .first<{
        id: string;
        captured_at: string;
        first_decision_at: string;
        days_in_window: number;
        decisions_in_window: number;
        attempts_per_success: number;
        time_to_success_seconds: number;
        drift_rate: number;
        success_rate: number;
        trigger_reason: string;
      }>();

    if (!baseline) {
      return this.buildOnboardingBlock(accountId);
    }

    // days_since_baseline = days since the baseline WINDOW ended, not since the row was inserted.
    const windowEnd = new Date(
      new Date(baseline.first_decision_at).getTime() +
        baseline.days_in_window * 86400000
    );
    const daysSinceBaseline = Math.max(0, this.daysBetween(windowEnd, new Date()));

    // Decisions since baseline: total - decisions_in_window
    const totalDecisions = await this.db
      .prepare('SELECT COUNT(*) AS c FROM decisions WHERE account_id = ?')
      .bind(accountId)
      .first<{ c: number }>();
    const decisionsSinceBaseline = Math.max(0, (totalDecisions?.c || 0) - baseline.decisions_in_window);

    // Current values come from VelocityService so they match the dashboard's velocity block exactly.
    const velocity = new VelocityService(this.db);
    const [aps, tts, drift, currentSuccessRate] = await Promise.all([
      velocity.getAttemptsPerSuccess(accountId, 7),
      velocity.getTimeToSuccess(accountId, 7),
      velocity.getDriftRate(accountId, 7),
      this.queryCurrentSuccessRate(accountId),
    ]);

    return {
      status: 'active',
      days_since_baseline: daysSinceBaseline,
      decisions_since_baseline: decisionsSinceBaseline,
      baseline_captured_at: baseline.captured_at,
      trigger_reason: baseline.trigger_reason,
      attempts_per_success: buildMetricDelta(baseline.attempts_per_success, aps.current, true),
      time_to_success_seconds: buildMetricDelta(baseline.time_to_success_seconds, tts.current, true),
      drift_rate: buildMetricDelta(baseline.drift_rate, drift.current, true),
      success_rate: buildMetricDelta(baseline.success_rate, currentSuccessRate, false),
    };
  }

  // ── d) getAgentImprovement ────────────────────────────────────────────────

  async getAgentImprovement(
    accountId: string,
    agentId: string
  ): Promise<ImprovementResult> {
    const baseline = await this.db
      .prepare(
        'SELECT * FROM agent_baselines WHERE account_id = ? AND agent_id = ? LIMIT 1'
      )
      .bind(accountId, agentId)
      .first<{
        id: string;
        captured_at: string;
        first_decision_at: string;
        days_in_window: number;
        decisions_in_window: number;
        attempts_per_success: number;
        time_to_success_seconds: number;
        drift_rate: number;
        success_rate: number;
        trigger_reason: string;
      }>();

    if (!baseline) {
      return this.buildOnboardingBlock(accountId, agentId);
    }

    const windowEnd = new Date(
      new Date(baseline.first_decision_at).getTime() +
        baseline.days_in_window * 86400000
    );
    const daysSinceBaseline = Math.max(0, this.daysBetween(windowEnd, new Date()));

    const totalDecisions = await this.db
      .prepare(
        'SELECT COUNT(*) AS c FROM decisions WHERE account_id = ? AND COALESCE(agent_id, session_id) = ?'
      )
      .bind(accountId, agentId)
      .first<{ c: number }>();
    const decisionsSinceBaseline = Math.max(
      0,
      (totalDecisions?.c || 0) - baseline.decisions_in_window
    );

    const velocity = new VelocityService(this.db);
    const [aps, tts, drift, currentSuccessRate] = await Promise.all([
      velocity.getAttemptsPerSuccess(accountId, 7, agentId),
      velocity.getTimeToSuccess(accountId, 7, agentId),
      velocity.getDriftRate(accountId, 7, agentId),
      this.queryCurrentSuccessRate(accountId, agentId),
    ]);

    return {
      status: 'active',
      days_since_baseline: daysSinceBaseline,
      decisions_since_baseline: decisionsSinceBaseline,
      baseline_captured_at: baseline.captured_at,
      trigger_reason: baseline.trigger_reason,
      attempts_per_success: buildMetricDelta(
        baseline.attempts_per_success,
        aps.current,
        true
      ),
      time_to_success_seconds: buildMetricDelta(
        baseline.time_to_success_seconds,
        tts.current,
        true
      ),
      drift_rate: buildMetricDelta(
        baseline.drift_rate,
        drift.current,
        true
      ),
      success_rate: buildMetricDelta(
        baseline.success_rate,
        currentSuccessRate,
        false
      ),
    };
  }

  // ── e) backfillBaselinesForAccount ──────────────────────────────────────

  /**
   * Always inserts a baseline (ignores eligibility). Safe to re-call — INSERT
   * will silently no-op if UNIQUE constraint fires. Returns which got inserted.
   */
  async backfillBaselinesForAccount(
    accountId: string
  ): Promise<{ account: boolean; agents: string[] }> {
    // Account-level backfill
    const firstRow = await this.db
      .prepare('SELECT MIN(created_at) AS first_at FROM decisions WHERE account_id = ? LIMIT 1')
      .bind(accountId)
      .first<{ first_at: string | null }>();

    let accountBackfilled = false;
    if (firstRow?.first_at) {
      const firstAt = firstRow.first_at;
      const capturedAt = new Date().toISOString();
      const baselineEndTs = this.baselineWindowEnd(firstAt);

      const countRow = await this.db
        .prepare(`
          SELECT COUNT(*) AS c FROM decisions
          WHERE account_id = ?
            AND created_at >= ?
            AND created_at <= datetime(?, '+7 days')
        `)
        .bind(accountId, firstAt, firstAt)
        .first<{ c: number }>();
      const decisionsInWindow = countRow?.c || 0;

      if (decisionsInWindow > 0) {
        const daysElapsed = this.daysBetween(new Date(firstAt), new Date());
        const triggerReason: 'time_7d' | 'volume_20' =
          daysElapsed >= 7 ? 'time_7d' : 'volume_20';
        const metrics = await this.computeBaselineMetrics(accountId, firstAt, baselineEndTs);

        try {
          await this.db
            .prepare(`
              INSERT INTO account_baselines
                (id, account_id, captured_at, first_decision_at, days_in_window,
                 decisions_in_window, attempts_per_success, time_to_success_seconds,
                 drift_rate, success_rate, trigger_reason)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              crypto.randomUUID(),
              accountId,
              capturedAt,
              firstAt,
              Math.min(daysElapsed, 7),
              decisionsInWindow,
              metrics.attempts_per_success,
              metrics.time_to_success_seconds,
              metrics.drift_rate,
              metrics.success_rate,
              triggerReason
            )
            .run();
          accountBackfilled = true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('UNIQUE constraint')) {
            accountBackfilled = true;  // already existed
          } else {
            throw e;  // real failure — don't hide it
          }
        }
      }
    }

    // Per-agent backfills (prefer agent_id; fall back to session_id for historical data)
    const agentRows = await this.db
      .prepare(`
        SELECT DISTINCT COALESCE(agent_id, session_id) AS agent_key
        FROM decisions
        WHERE account_id = ?
          AND (agent_id IS NOT NULL OR session_id IS NOT NULL)
      `)
      .bind(accountId)
      .all<{ agent_key: string }>();

    const backfilledAgents: string[] = [];
    for (const row of agentRows.results || []) {
      const agentKey = row.agent_key;
      if (!agentKey) continue;

      const agentFirstRow = await this.db
        .prepare(
          'SELECT MIN(created_at) AS first_at FROM decisions WHERE account_id = ? AND COALESCE(agent_id, session_id) = ? LIMIT 1'
        )
        .bind(accountId, agentKey)
        .first<{ first_at: string | null }>();
      if (!agentFirstRow?.first_at) continue;

      const firstAt = agentFirstRow.first_at;
      const capturedAt = new Date().toISOString();
      const baselineEndTs = this.baselineWindowEnd(firstAt);
      const agentCountRow = await this.db
        .prepare(`
          SELECT COUNT(*) AS c FROM decisions
          WHERE account_id = ? AND COALESCE(agent_id, session_id) = ?
            AND created_at >= ?
            AND created_at <= datetime(?, '+7 days')
        `)
        .bind(accountId, agentKey, firstAt, firstAt)
        .first<{ c: number }>();
      const decisionsInWindow = agentCountRow?.c || 0;

      if (decisionsInWindow === 0) continue;

      const daysElapsed = this.daysBetween(new Date(firstAt), new Date());
      const triggerReason: 'time_7d' | 'volume_20' =
        daysElapsed >= 7 ? 'time_7d' : 'volume_20';
      const metrics = await this.computeBaselineMetrics(accountId, firstAt, baselineEndTs, agentKey);

      try {
        await this.db
          .prepare(`
            INSERT INTO agent_baselines
              (id, account_id, agent_id, captured_at, first_decision_at, days_in_window,
               decisions_in_window, attempts_per_success, time_to_success_seconds,
               drift_rate, success_rate, trigger_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            crypto.randomUUID(),
            accountId,
            agentKey,
            capturedAt,
            firstAt,
            Math.min(daysElapsed, 7),
            decisionsInWindow,
            metrics.attempts_per_success,
            metrics.time_to_success_seconds,
            metrics.drift_rate,
            metrics.success_rate,
            triggerReason
          )
          .run();
        backfilledAgents.push(agentKey);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('UNIQUE constraint')) {
          backfilledAgents.push(agentKey);  // already existed
        } else {
          throw e;  // real failure — don't hide it
        }
      }
    }

    return { account: accountBackfilled, agents: backfilledAgents };
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /**
   * Compute all four metrics over [fromTs, toTs].
   * When agentId is provided, scope to that agent via COALESCE(agent_id, session_id).
   */
  private async computeBaselineMetrics(
    accountId: string,
    fromTs: string,
    toTs: string,
    agentId?: string
  ): Promise<BaselineMetrics> {
    const agentFilter = agentId
      ? ' AND COALESCE(agent_id, session_id) = ? '
      : ' ';
    const groupKey = agentId ? 'COALESCE(agent_id, session_id)' : 'session_id';
    const agentBindings: string[] = agentId ? [agentId] : [];

    const baseBindings = [accountId, fromTs, toTs, ...agentBindings];

    // Attempts per success
    const apsRow = await this.db
      .prepare(`
        SELECT AVG(CAST(total AS REAL) / successes) AS avg_attempts
        FROM (
          SELECT ${groupKey} AS entity_key, COUNT(*) AS total,
                 SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) AS successes
          FROM decisions
          WHERE account_id = ?
            AND created_at >= datetime(?)
            AND created_at <= datetime(?)
            ${agentFilter}
          GROUP BY ${groupKey}
          HAVING successes > 0
        )
      `)
      .bind(...baseBindings)
      .first<{ avg_attempts: number | null }>();

    // Median time-to-success
    const countRow = await this.db
      .prepare(`
        SELECT COUNT(*) AS total FROM decisions
        WHERE account_id = ?
          AND outcome_success = 1
          AND outcome_recorded_at IS NOT NULL
          AND created_at >= datetime(?)
          AND created_at <= datetime(?)
          ${agentFilter}
      `)
      .bind(...baseBindings)
      .first<{ total: number }>();
    const total = countRow?.total || 0;

    let medianTts = 0;
    if (total > 0) {
      const medianRow = await this.db
        .prepare(`
          SELECT CAST((julianday(outcome_recorded_at) - julianday(created_at)) * 86400 AS INTEGER) AS delta_seconds
          FROM decisions
          WHERE account_id = ?
            AND outcome_success = 1
            AND outcome_recorded_at IS NOT NULL
            AND created_at >= datetime(?)
            AND created_at <= datetime(?)
            ${agentFilter}
          ORDER BY delta_seconds
          LIMIT 1 OFFSET ?
        `)
        .bind(...baseBindings, Math.floor(total / 2))
        .first<{ delta_seconds: number | null }>();
      medianTts = medianRow?.delta_seconds ?? 0;
    }

    // Drift rate
    const driftRow = await this.db
      .prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN cluster_id IS NULL THEN 1 ELSE 0 END) AS drift_count
        FROM decisions
        WHERE account_id = ?
          AND created_at >= datetime(?)
          AND created_at <= datetime(?)
          ${agentFilter}
      `)
      .bind(...baseBindings)
      .first<{ total: number; drift_count: number | null }>();
    const totalDec = driftRow?.total || 0;
    const driftCount = driftRow?.drift_count || 0;
    const driftRate = totalDec > 0 ? (driftCount / totalDec) * 100 : 0;

    // Success rate
    const srRow = await this.db
      .prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) AS successes
        FROM decisions
        WHERE account_id = ?
          AND outcome_recorded_at IS NOT NULL
          AND created_at >= datetime(?)
          AND created_at <= datetime(?)
          ${agentFilter}
      `)
      .bind(...baseBindings)
      .first<{ total: number; successes: number | null }>();
    const totalSr = srRow?.total || 0;
    const successes = srRow?.successes || 0;
    const successRate = totalSr > 0 ? successes / totalSr : 0;

    return {
      attempts_per_success: apsRow?.avg_attempts ? Number(apsRow.avg_attempts) : 0,
      time_to_success_seconds: medianTts,
      drift_rate: driftRate,
      success_rate: successRate,
    };
  }

  private async buildOnboardingBlock(
    accountId: string,
    agentId?: string
  ): Promise<OnboardingBlock> {
    const agentFilter = agentId
      ? ' AND COALESCE(agent_id, session_id) = ? '
      : ' ';
    const bindings = agentId ? [accountId, agentId] : [accountId];

    const firstRow = await this.db
      .prepare(
        `SELECT MIN(created_at) AS first_at FROM decisions WHERE account_id = ?${agentFilter} LIMIT 1`
      )
      .bind(...bindings)
      .first<{ first_at: string | null }>();

    const totalRow = await this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM decisions WHERE account_id = ?${agentFilter}`
      )
      .bind(...bindings)
      .first<{ c: number }>();

    const firstAt = firstRow?.first_at;
    const decisionsElapsed = totalRow?.c || 0;
    const daysElapsed = firstAt
      ? this.daysBetween(new Date(firstAt), new Date())
      : 0;

    const decisionsUntilVolume = Math.max(0, 20 - decisionsElapsed);
    const daysUntilTime = Math.max(0, 7 - daysElapsed);

    return {
      status: 'onboarding',
      days_elapsed: daysElapsed,
      decisions_elapsed: decisionsElapsed,
      days_until_time_trigger: daysUntilTime,
      decisions_until_volume_trigger: decisionsUntilVolume,
      reason:
        'Baseline captures on day 7 or after 20 decisions, whichever comes first.',
    };
  }

  private daysBetween(from: Date, to: Date): number {
    return Math.round(
      (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)
    );
  }

  /**
   * Baseline window ends at firstAt + 7 days (or now, if earlier — for accounts
   * that haven't been active a full week yet). Returns an ISO string to pass to
   * computeBaselineMetrics as toTs, ensuring the baseline only reflects the
   * first-7-days activity, not the entire account history.
   */
  private baselineWindowEnd(firstAt: string): string {
    const endByTime = new Date(new Date(firstAt).getTime() + 7 * 86400000);
    const now = new Date();
    return (endByTime < now ? endByTime : now).toISOString();
  }

  /**
   * Current rolling 7-day success rate using the same datetime('now', '-7 days')
   * anchor as VelocityService, so improvement.current.success_rate matches the
   * dashboard's velocity window exactly.
   */
  private async queryCurrentSuccessRate(
    accountId: string,
    agentId?: string
  ): Promise<number> {
    const agentFilter = agentId
      ? ' AND COALESCE(agent_id, session_id) = ? '
      : ' ';
    const bindings = agentId ? [accountId, agentId] : [accountId];

    const row = await this.db
      .prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) AS successes
        FROM decisions
        WHERE account_id = ?
          AND outcome_recorded_at IS NOT NULL
          AND created_at > datetime('now', '-7 days')
          ${agentFilter}
      `)
      .bind(...bindings)
      .first<{ total: number; successes: number | null }>();
    const total = row?.total || 0;
    const successes = row?.successes || 0;
    return total > 0 ? successes / total : 0;
  }
}