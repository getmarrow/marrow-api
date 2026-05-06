import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../index';
import { createMockD1, REAL_ACCOUNT_ID, REAL_API_KEY, TEST_ENCRYPTION_KEY } from './helpers';

describe('GET /v1/analytics/value-report', () => {
  let db: D1Database;

  beforeEach(() => {
    db = createMockD1();
  });

  function env() {
    return {
      DB: db,
      ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      ENVIRONMENT: 'test',
    } as any;
  }

  function ctx(): ExecutionContext {
    return {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext;
  }

  async function authedFetch(path: string) {
    return worker.fetch(
      new Request(`https://api.getmarrow.ai${path}`, {
        headers: { Authorization: `Bearer ${REAL_API_KEY}` },
      }),
      env(),
      ctx(),
    );
  }

  async function seedDecisions() {
    const now = new Date().toISOString();
    await insertDecision(
      'deploy-ok',
      REAL_ACCOUNT_ID,
      'deploy',
      { action: 'deploy worker with secret-token-should-not-leak' },
      'deployed successfully with private details',
      'jarvis-session',
      'jarvis',
      1,
      now,
    );

    await insertDecision(
      'deploy-fail',
      REAL_ACCOUNT_ID,
      'deploy',
      { action: 'deploy failed because of private prod details' },
      'failed with private stack trace',
      'jarvis-session',
      'jarvis',
      0,
      now,
    );

    await insertDecision(
      'backend-ok',
      REAL_ACCOUNT_ID,
      'backend',
      { action: 'patch endpoint' },
      'patched successfully',
      'darvis-session',
      'darvis',
      1,
      now,
    );
  }

  async function insertDecision(
    id: string,
    accountId: string,
    decisionType: string,
    context: Record<string, unknown>,
    outcome: string,
    sessionId: string,
    agentId: string,
    outcomeSuccess: number,
    timestamp: string,
  ) {
    await db.prepare(`
      INSERT INTO decisions
        (id, account_id, decision_type, context, outcome, confidence, visibility,
         outcome_success, outcome_recorded_at, session_id, agent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      accountId,
      decisionType,
      JSON.stringify(context),
      outcome,
      0.8,
      'private',
      outcomeSuccess,
      timestamp,
      sessionId,
      agentId,
      timestamp,
      timestamp,
    ).run();
  }

  async function insertBaseline(table: 'account_baselines' | 'agent_baselines', id: string, triggerReason: string, agentId?: string) {
    const now = new Date().toISOString();
    if (table === 'agent_baselines') {
      await db.prepare(`
        INSERT INTO agent_baselines
          (id, account_id, agent_id, captured_at, first_decision_at, days_in_window,
           decisions_in_window, attempts_per_success, time_to_success_seconds,
           drift_rate, success_rate, trigger_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, REAL_ACCOUNT_ID, agentId, now, now, 1, 2, 2, 10, 0.1, 0.5, triggerReason).run();
      return;
    }

    await db.prepare(`
      INSERT INTO account_baselines
        (id, account_id, captured_at, first_decision_at, days_in_window,
         decisions_in_window, attempts_per_success, time_to_success_seconds,
         drift_rate, success_rate, trigger_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, REAL_ACCOUNT_ID, now, now, 1, 3, 3, 20, 0.2, 0.6, triggerReason).run();
  }

  it('returns an agent-native owner summary and machine-readable metrics', async () => {
    await seedDecisions();

    const res = await authedFetch('/v1/analytics/value-report?period=7');

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.summary).toContain('Your agent fleet made 3 decisions');
    expect(body.data.metrics.decisions.total).toBe(3);
    expect(body.data.metrics.decisions.successful).toBe(2);
    expect(body.data.metrics.decisions.failed).toBe(1);
    expect(body.data.metrics.success_rate).toBeCloseTo(0.667, 3);
    expect(body.data.fleet.active_agents).toBe(2);
    expect(body.data.risks.top_failure_types[0].decision_type).toBe('deploy');
    expect(Array.isArray(body.data.recommendations)).toBe(true);
  });

  it('filters reports to a single agent id', async () => {
    await seedDecisions();

    const res = await authedFetch('/v1/analytics/value-report?period=7&agent_id=jarvis');

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.scope.agent_id).toBe('jarvis');
    expect(body.data.summary).toContain('Agent jarvis made 2 decisions');
    expect(body.data.metrics.decisions.total).toBe(2);
    expect(body.data.fleet.top_agents).toHaveLength(1);
    expect(body.data.fleet.top_agents[0].agent_id).toBe('jarvis');
  });

  it('rejects invalid agent id filters', async () => {
    await seedDecisions();

    const res = await authedFetch('/v1/analytics/value-report?period=7&agent_id=bad/slash');

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe('BAD_REQUEST');
    expect(body.error).toBe('Invalid agent_id');
  });

  it('uses agent-scoped improvement for agent reports', async () => {
    await seedDecisions();
    await insertBaseline('account_baselines', 'account-baseline', 'account_marker');
    await insertBaseline('agent_baselines', 'jarvis-baseline', 'agent_marker', 'jarvis');

    const res = await authedFetch('/v1/analytics/value-report?period=7&agent_id=jarvis');

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.scope.agent_id).toBe('jarvis');
    expect(body.data.improvement.status).toBe('active');
    expect(body.data.improvement.trigger_reason).toBe('agent_marker');
  });

  it('does not reflect raw action, context, or outcome text in reports', async () => {
    await seedDecisions();

    const res = await authedFetch('/v1/analytics/value-report?period=7');
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain('secret-token-should-not-leak');
    expect(text).not.toContain('private stack trace');
    expect(text).not.toContain('private prod details');
  });

  it('requires authorization', async () => {
    const res = await worker.fetch(
      new Request('https://api.getmarrow.ai/v1/analytics/value-report'),
      env(),
      ctx(),
    );

    expect(res.status).toBe(401);
  });
});
