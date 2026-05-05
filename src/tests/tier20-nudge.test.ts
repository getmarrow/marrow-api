import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../index';
import { NudgeService } from '../services/nudge.service';
import { createMockD1, REAL_ACCOUNT_ID, REAL_API_KEY, TEST_ENCRYPTION_KEY } from './helpers';

describe('Tier 20: Marrow Nudge', () => {
  let db: D1Database;

  beforeEach(() => {
    db = createMockD1();
  });

  async function seedDecisions(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await db.prepare(`
        INSERT INTO decisions (
          id, account_id, decision_type, context, outcome,
          confidence, visibility, context_compressed,
          session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        `dec-${i}`,
        REAL_ACCOUNT_ID,
        'implementation',
        JSON.stringify({ action: `task ${i}` }),
        `outcome ${i}`,
        0.8,
        'hive',
        0,
        'sess-1',
        new Date(Date.now() - (count - i) * 1000).toISOString(),
        new Date(Date.now() - (count - i) * 1000).toISOString(),
      ).run();
    }
  }

  it('returns false when total decisions are below the 50-decision threshold', async () => {
    await seedDecisions(49);
    const service = new NudgeService(db, {
      baselineService: {
        captureAccountBaselineIfEligible: async () => {},
        getAccountImprovement: async () => ({ status: 'active', days_since_baseline: 10, decisions_since_baseline: 30, baseline_captured_at: new Date().toISOString(), trigger_reason: 'volume_20', attempts_per_success: { baseline: 2, current: 1.5, delta_pct: -25 }, time_to_success_seconds: { baseline: 100, current: 70, delta_pct: -30 }, drift_rate: { baseline: 40, current: 20, delta_pct: -50 }, success_rate: { baseline: 0.5, current: 0.7, delta_pct: 40 } }),
      },
      impactService: { getSavesCount: async () => ({ thisWeek: 1, total: 2 }) },
    });

    await expect(service.checkNudge(REAL_ACCOUNT_ID)).resolves.toEqual({ nudge: false, message: null, metrics: null });
  });

  it('returns false when fewer than 50 decisions passed since the last nudge', async () => {
    await seedDecisions(80);
    await db.prepare('UPDATE accounts SET nudged_decision_count = ?, nudged_at = ? WHERE id = ?').bind(40, new Date().toISOString(), REAL_ACCOUNT_ID).run();

    const service = new NudgeService(db, {
      baselineService: {
        captureAccountBaselineIfEligible: async () => {},
        getAccountImprovement: async () => ({ status: 'active', days_since_baseline: 10, decisions_since_baseline: 60, baseline_captured_at: new Date().toISOString(), trigger_reason: 'volume_20', attempts_per_success: { baseline: 2, current: 1.5, delta_pct: -25 }, time_to_success_seconds: { baseline: 100, current: 70, delta_pct: -30 }, drift_rate: { baseline: 40, current: 20, delta_pct: -50 }, success_rate: { baseline: 0.5, current: 0.7, delta_pct: 40 } }),
      },
      impactService: { getSavesCount: async () => ({ thisWeek: 1, total: 2 }) },
    });

    await expect(service.checkNudge(REAL_ACCOUNT_ID)).resolves.toEqual({ nudge: false, message: null, metrics: null });
  });

  it('returns false while the account is still onboarding', async () => {
    await seedDecisions(70);
    const service = new NudgeService(db, {
      baselineService: {
        captureAccountBaselineIfEligible: async () => {},
        getAccountImprovement: async () => ({ status: 'onboarding', days_elapsed: 3, decisions_elapsed: 18, days_until_time_trigger: 4, decisions_until_volume_trigger: 2, reason: 'Baseline captures on day 7 or after 20 decisions, whichever comes first.' }),
      },
      impactService: { getSavesCount: async () => ({ thisWeek: 0, total: 0 }) },
    });

    await expect(service.checkNudge(REAL_ACCOUNT_ID)).resolves.toEqual({ nudge: false, message: null, metrics: null });
  });

  it('returns false when there are no positive improvements to report', async () => {
    await seedDecisions(70);
    const service = new NudgeService(db, {
      baselineService: {
        captureAccountBaselineIfEligible: async () => {},
        getAccountImprovement: async () => ({ status: 'active', days_since_baseline: 10, decisions_since_baseline: 60, baseline_captured_at: new Date().toISOString(), trigger_reason: 'volume_20', attempts_per_success: { baseline: 2, current: 2.2, delta_pct: 10 }, time_to_success_seconds: { baseline: 100, current: 110, delta_pct: 10 }, drift_rate: { baseline: 40, current: 50, delta_pct: 25 }, success_rate: { baseline: 0.7, current: 0.68, delta_pct: -2.86 } }),
      },
      impactService: { getSavesCount: async () => ({ thisWeek: 0, total: 0 }) },
    });

    await expect(service.checkNudge(REAL_ACCOUNT_ID)).resolves.toEqual({ nudge: false, message: null, metrics: null });
  });

  it('generates a short message from the strongest improvements and updates account state', async () => {
    await seedDecisions(87);
    const now = new Date('2026-05-05T12:00:00.000Z');
    const service = new NudgeService(db, {
      now: () => now,
      baselineService: {
        captureAccountBaselineIfEligible: async () => {},
        getAccountImprovement: async () => ({ status: 'active', days_since_baseline: 15, decisions_since_baseline: 67, baseline_captured_at: '2026-04-20T00:00:00.000Z', trigger_reason: 'volume_20', attempts_per_success: { baseline: 2.1, current: 1.5, delta_pct: -28.57 }, time_to_success_seconds: { baseline: 100, current: 66, delta_pct: -34 }, drift_rate: { baseline: 35, current: 20, delta_pct: -42.86 }, success_rate: { baseline: 0.56, current: 0.7, delta_pct: 25 } }),
      },
      impactService: { getSavesCount: async () => ({ thisWeek: 2, total: 6 }) },
    });

    const result = await service.checkNudge(REAL_ACCOUNT_ID);
    expect(result.nudge).toBe(true);
    expect(result.message).toContain('87 decisions ago');
    expect((result.message || '').length).toBeLessThanOrEqual(300);
    expect(result.metrics?.highlights).toHaveLength(3);
    const account = await db.prepare('SELECT nudged_at, nudged_decision_count FROM accounts WHERE id = ?').bind(REAL_ACCOUNT_ID).first<{ nudged_at: string; nudged_decision_count: number }>();
    expect(account?.nudged_at).toBe(now.toISOString());
    expect(account?.nudged_decision_count).toBe(87);
  });

  it('includes saves when they are one of the strongest highlights', async () => {
    await seedDecisions(70);
    const service = new NudgeService(db, {
      baselineService: {
        captureAccountBaselineIfEligible: async () => {},
        getAccountImprovement: async () => ({ status: 'active', days_since_baseline: 10, decisions_since_baseline: 50, baseline_captured_at: new Date().toISOString(), trigger_reason: 'volume_20', attempts_per_success: { baseline: 2, current: 1.9, delta_pct: -5 }, time_to_success_seconds: { baseline: 100, current: 90, delta_pct: -10 }, drift_rate: { baseline: 40, current: 39, delta_pct: -2.5 }, success_rate: { baseline: 0.5, current: 0.51, delta_pct: 2 } }),
      },
      impactService: { getSavesCount: async () => ({ thisWeek: 1, total: 5 }) },
    });

    const result = await service.checkNudge(REAL_ACCOUNT_ID);
    expect(result.nudge).toBe(true);
    expect(result.metrics?.highlights.some((h) => h.key === 'saves_count')).toBe(true);
    expect(result.message).toContain('avoided 5 known mistakes');
  });

  it('shortens the message when all three highlights would get too wordy', async () => {
    await seedDecisions(120);
    const service = new NudgeService(db, {
      baselineService: {
        captureAccountBaselineIfEligible: async () => {},
        getAccountImprovement: async () => ({ status: 'active', days_since_baseline: 33, decisions_since_baseline: 100, baseline_captured_at: new Date().toISOString(), trigger_reason: 'time_7d', attempts_per_success: { baseline: 3.456, current: 1.123, delta_pct: -67.5 }, time_to_success_seconds: { baseline: 999, current: 123, delta_pct: -87.69 }, drift_rate: { baseline: 70, current: 8, delta_pct: -88.57 }, success_rate: { baseline: 0.41, current: 0.91, delta_pct: 121.95 } }),
      },
      impactService: { getSavesCount: async () => ({ thisWeek: 4, total: 11 }) },
    });

    const result = await service.checkNudge(REAL_ACCOUNT_ID);
    expect(result.nudge).toBe(true);
    expect((result.message || '').length).toBeLessThanOrEqual(300);
  });

  it('serves the nudge endpoint with auth', async () => {
    const spy = vi.spyOn(NudgeService.prototype, 'checkNudge').mockResolvedValue({
      nudge: true,
      message: 'Since we last checked 55 decisions ago, you\'re 22% faster.',
      metrics: {
        total_decisions: 55,
        decisions_since_last_nudge: 55,
        nudged_at: '2026-05-05T12:00:00.000Z',
        nudged_decision_count: 55,
        saves_count: 1,
        highlights: [],
        improvement: null,
      },
    });

    const response = await worker.fetch(
      new Request('https://api.getmarrow.ai/v1/agent/nudge', {
        method: 'GET',
        headers: { Authorization: `Bearer ${REAL_API_KEY}` },
      }),
      { DB: db, ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, ENVIRONMENT: 'test' } as any,
      { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { data: { nudge: boolean; message: string } };
    expect(payload.data.nudge).toBe(true);
    expect(payload.data.message).toContain('55 decisions ago');
    spy.mockRestore();
  });
});
