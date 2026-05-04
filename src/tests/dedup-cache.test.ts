import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../index';
import { autoLogDecision } from '../middleware/auto-logger';
import { clearDedupCache } from '../middleware/dedup-cache';
import { createMockD1, REAL_ACCOUNT_ID, REAL_API_KEY, TEST_ENCRYPTION_KEY } from './helpers';

describe('Rapid call deduplication + auto-log context stripping', () => {
  let db: D1Database;

  beforeEach(() => {
    db = createMockD1();
    clearDedupCache();
  });

  it('dedups repeated think calls within 5 seconds and reuses the first decision_id', async () => {
    const first = await worker.fetch(
      new Request('https://api.getmarrow.ai/v1/agent/think', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REAL_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Marrow-Session-Id': 'sess-dedup-think',
        },
        body: JSON.stringify({ action: 'implement dedup cache for auto logs', type: 'implementation' }),
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

    const firstBody = await first.json() as { data: Record<string, unknown> };
    const firstDecisionId = String(firstBody.data.decision_id);

    const second = await worker.fetch(
      new Request('https://api.getmarrow.ai/v1/agent/think', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REAL_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Marrow-Session-Id': 'sess-dedup-think',
        },
        body: JSON.stringify({ action: 'implement dedup cache for auto logs', type: 'implementation' }),
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

    expect(second.status).toBe(200);
    const secondBody = await second.json() as { data: Record<string, unknown> };
    expect(secondBody.data.decision_id).toBe(firstDecisionId);
    expect(secondBody.data.deduped).toBe(true);

    const generalCount = await db.prepare('SELECT COUNT(*) as c FROM decisions WHERE account_id = ? AND decision_type = ?').bind(REAL_ACCOUNT_ID, 'implementation').first<{ c: number }>();
    const autoLogCount = await db.prepare('SELECT COUNT(*) as c FROM decisions WHERE account_id = ? AND decision_type = ?').bind(REAL_ACCOUNT_ID, 'post_agent_think').first<{ c: number }>();
    expect(generalCount?.c || 0).toBe(1);
    expect(autoLogCount?.c || 0).toBe(1);
  });

  it('dedups repeated commit calls within 5 seconds and skips duplicate auto-log rows', async () => {
    const think = await worker.fetch(
      new Request('https://api.getmarrow.ai/v1/agent/think', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REAL_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Marrow-Session-Id': 'sess-dedup-commit',
        },
        body: JSON.stringify({ action: 'deploy commit dedup test', type: 'implementation' }),
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

    const thinkBody = await think.json() as { data: Record<string, unknown> };
    const decisionId = String(thinkBody.data.decision_id);

    const commitRequest = new Request('https://api.getmarrow.ai/v1/agent/commit', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REAL_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Marrow-Session-Id': 'sess-dedup-commit',
      },
      body: JSON.stringify({ decision_id: decisionId, success: true, outcome: 'deployed commit dedup test successfully' }),
    });

    const firstCommit = await worker.fetch(
      commitRequest.clone(),
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
    expect(firstCommit.status).toBe(200);

    const secondCommit = await worker.fetch(
      commitRequest.clone(),
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

    expect(secondCommit.status).toBe(200);
    const secondCommitBody = await secondCommit.json() as { data: Record<string, unknown> };
    expect(secondCommitBody.data.deduped).toBe(true);
    expect(secondCommitBody.data.decision_id).toBe(decisionId);

    const autoLogCount = await db.prepare('SELECT COUNT(*) as c FROM decisions WHERE account_id = ? AND decision_type = ?').bind(REAL_ACCOUNT_ID, 'post_agent_commit').first<{ c: number }>();
    expect(autoLogCount?.c || 0).toBe(1);
  });

  it('stores minimal compressed context for auto-logged decisions', async () => {
    await autoLogDecision({
      db,
      accountId: REAL_ACCOUNT_ID,
      method: 'POST',
      endpoint: '/v1/agent/think',
      statusCode: 201,
      body: {
        action: 'implement context stripping for auto logs',
        description: 'this should not be stored wholesale',
        nested: { secret: 'do-not-store-me' },
        token: 'mrw_should_not_be_logged',
      },
    });

    const row = await db.prepare('SELECT context, context_compressed FROM decisions WHERE account_id = ? AND decision_type = ? LIMIT 1').bind(REAL_ACCOUNT_ID, 'post_agent_think').first<{ context: string; context_compressed: number }>();
    expect(row?.context_compressed).toBe(1);

    const context = JSON.parse(row?.context || '{}') as Record<string, unknown>;
    expect(context).toEqual({
      method: 'POST',
      endpoint: '/v1/agent/think',
      statusCode: 201,
      action: 'implement context stripping for auto logs',
    });
    expect(JSON.stringify(context)).not.toContain('do-not-store-me');
    expect(JSON.stringify(context)).not.toContain('mrw_should_not_be_logged');
    expect(context).not.toHaveProperty('body');
  });
});
