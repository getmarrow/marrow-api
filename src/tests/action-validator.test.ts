import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../index';
import { autoLogDecision } from '../middleware/auto-logger';
import { isStrictQualityMode, validateActionQuality } from '../middleware/action-validator';
import { AuthService } from '../services/auth.service';
import { DecisionService } from '../services/decision.service';
import { createMockD1, REAL_ACCOUNT_ID, REAL_API_KEY, TEST_ENCRYPTION_KEY } from './helpers';

describe('Action quality gate', () => {
  let db: D1Database;

  beforeEach(() => {
    db = createMockD1();
  });

  it('rejects empty, short, low-entropy, noise, and no-verb actions', () => {
    expect(validateActionQuality('')).toMatchObject({ valid: false, code: 'action_required' });
    expect(validateActionQuality('too short')).toMatchObject({ valid: false, code: 'action_too_short' });
    expect(validateActionQuality('aaaaaaaaaa')).toMatchObject({ valid: false, code: 'action_lacks_substance' });
    expect(validateActionQuality('standing by')).toMatchObject({ valid: false, code: 'not_meaningful' });
    expect(validateActionQuality('context loading complete')).toMatchObject({ valid: false, code: 'no_verb' });
  });

  it('accepts meaningful actions with recognizable verbs', () => {
    expect(validateActionQuality('implement api key usage counter fix')).toEqual({ valid: true });
    expect(validateActionQuality('review deploy logs for waitUntil regression')).toEqual({ valid: true });
  });

  it('uses advisory mode by default and strict mode for test keys or env flag', () => {
    expect(isStrictQualityMode({ DB: db, ENCRYPTION_KEY: TEST_ENCRYPTION_KEY } as any, null)).toBe(false);
    expect(isStrictQualityMode({ DB: db, ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, MARROW_STRICT_QUALITY: 'true' } as any, null)).toBe(true);
    expect(isStrictQualityMode({ DB: db, ENCRYPTION_KEY: TEST_ENCRYPTION_KEY } as any, { api_key_type: 'test' } as any)).toBe(true);
  });

  it('skips auto-log inserts for rejected noise actions', async () => {
    await autoLogDecision({
      db,
      accountId: REAL_ACCOUNT_ID,
      method: 'GET',
      endpoint: '/v1/auth/account',
      statusCode: 200,
      body: { action: 'standing by' },
    });

    const rows = await db.prepare('SELECT COUNT(*) as c FROM decisions WHERE account_id = ?').bind(REAL_ACCOUNT_ID).first<{ c: number }>();
    expect(rows?.c || 0).toBe(0);
  });

  it('still auto-logs meaningful actions', async () => {
    await autoLogDecision({
      db,
      accountId: REAL_ACCOUNT_ID,
      method: 'POST',
      endpoint: '/v1/agent/think',
      statusCode: 200,
      body: { action: 'implement api key usage counter fix' },
    });

    const rows = await db.prepare('SELECT COUNT(*) as c FROM decisions WHERE account_id = ?').bind(REAL_ACCOUNT_ID).first<{ c: number }>();
    expect(rows?.c || 0).toBe(1);
  });

  it('rejects noisy think actions in strict mode with zero decision writes', async () => {
    const waitUntilPromises: Promise<unknown>[] = [];

    const response = await worker.fetch(
      new Request('https://api.getmarrow.ai/v1/agent/think', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REAL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'standing by', type: 'general' }),
      }),
      {
        DB: db,
        ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        ENVIRONMENT: 'test',
        MARROW_STRICT_QUALITY: 'true',
      } as any,
      {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
        passThroughOnException() {},
      } as ExecutionContext
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'not_meaningful',
      message: 'Action not meaningful enough to log. Requires a specific verb describing what was done.',
      hint: "Instead of 'checking context', try 'Updated memory with session context'",
    });

    await Promise.all(waitUntilPromises);
    const rows = await db.prepare('SELECT COUNT(*) as c FROM decisions WHERE account_id = ?').bind(REAL_ACCOUNT_ID).first<{ c: number }>();
    expect(rows?.c || 0).toBe(0);
  });

  it('keeps advisory behavior for noisy live-key think actions', async () => {
    const response = await worker.fetch(
      new Request('https://api.getmarrow.ai/v1/agent/think', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REAL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'standing by', type: 'general' }),
      }),
      {
        DB: db,
        ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        ENVIRONMENT: 'test',
      } as any,
      {
        waitUntil() {},
        passThroughOnException() {},
      } as ExecutionContext
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { data?: Record<string, unknown> };
    const body = payload.data || {};
    expect(body.filtered).toBe(true);
    expect(Array.isArray(body.warnings)).toBe(true);

    const decisions = await new DecisionService(db).listDecisions(REAL_ACCOUNT_ID, { decision_type: 'general', limit: 5 });
    expect(decisions[0]?.quality).toBe('trivial');
  });

  it('rejects noisy commit outcomes in strict mode without recording an outcome', async () => {
    const decision = await new DecisionService(db).createDecision(
      REAL_ACCOUNT_ID,
      'general',
      { action: 'implement auth fix' },
      'implement auth fix',
      0.5,
      'hive',
      'enterprise'
    );

    const response = await worker.fetch(
      new Request('https://api.getmarrow.ai/v1/agent/commit', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REAL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision_id: decision.id, success: true, outcome: 'all good' }),
      }),
      {
        DB: db,
        ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        ENVIRONMENT: 'test',
        MARROW_STRICT_QUALITY: 'true',
      } as any,
      {
        waitUntil() {},
        passThroughOnException() {},
      } as ExecutionContext
    );

    expect(response.status).toBe(400);

    const stored = await new DecisionService(db).getDecision(decision.id, REAL_ACCOUNT_ID);
    expect(stored?.outcome_recorded_at).toBeUndefined();
    expect(stored?.outcome_success).toBeUndefined();
  });
});
