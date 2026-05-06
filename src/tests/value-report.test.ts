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

  it('ignores invalid agent id filters', async () => {
    await seedDecisions();

    const res = await authedFetch('/v1/analytics/value-report?period=7&agent_id=bad/slash');

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.scope.agent_id).toBeNull();
    expect(body.data.metrics.decisions.total).toBe(3);
    expect(body.data.fleet.active_agents).toBe(2);
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
