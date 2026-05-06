import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../index';
import { createMockD1, REAL_API_KEY, TEST_ENCRYPTION_KEY } from './helpers';

describe('POST /v1/workflow/gate', () => {
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

  async function gate(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return worker.fetch(
      new Request('https://api.getmarrow.ai/v1/workflow/gate', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REAL_API_KEY}`,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      }),
      env(),
      ctx(),
    );
  }

  it('allows a low-risk agent action and returns validated agent/session hints', async () => {
    const res = await gate({
      action: 'Document the integration setup for the SDK',
      decision_type: 'documentation',
    }, {
      'X-Marrow-Agent-Id': 'darvis',
      'X-Marrow-Session-Id': 'session-123',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.allow).toBe(true);
    expect(body.data.decision).toBe('allow');
    expect(body.data.risk_level).toBe('low');
    expect(body.data.action).toBeUndefined();
    expect(body.data.decision_type).toBeUndefined();
    expect(body.data.agent_id).toBe('darvis');
    expect(body.data.session_id).toBe('session-123');
    expect(body.data.next.recommended_endpoint).toBe('/v1/workflow/before');
  });

  it('omits invalid agent and session header hints', async () => {
    const res = await gate({
      action: 'Document the integration setup for the SDK',
    }, {
      'X-Marrow-Agent-Id': 'darvis/secret',
      'X-Marrow-Session-Id': 'x'.repeat(200),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.agent_id).toBeNull();
    expect(body.data.session_id).toBeNull();
  });

  it('requires review for production-sensitive actions at default tolerance', async () => {
    const res = await gate({
      action: 'Deploy the Cloudflare Worker to production',
      decision_type: 'deployment',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.allow).toBe(false);
    expect(body.data.decision).toBe('review_required');
    expect(body.data.risk_level).toBe('high');
    expect(body.data.reasons[0].code).toBe('high_risk_action');
    expect(body.data.next.recommended_endpoint).toBeNull();
  });

  it('blocks trivial actions before they enter the workflow loop', async () => {
    const res = await gate({ action: 'ok' });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.allow).toBe(false);
    expect(body.data.decision).toBe('block');
    expect(body.data.reasons[0].code).toBe('action_too_short');
  });

  it('validates the required action field', async () => {
    const res = await gate({ decision_type: 'maintenance' });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe('BAD_REQUEST');
  });

  it('rejects requests without authorization', async () => {
    const res = await worker.fetch(
      new Request('https://api.getmarrow.ai/v1/workflow/gate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'Document the integration setup for the SDK' }),
      }),
      env(),
      ctx(),
    );

    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('rejects test keys on production gate routes', async () => {
    await db.prepare(`UPDATE api_keys SET key_type = 'test' WHERE id = ?`).bind('key-prod-001').run();

    const res = await worker.fetch(
      new Request('https://api.getmarrow.ai/v1/workflow/gate', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REAL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'Document the integration setup for the SDK' }),
      }),
      env(),
      ctx(),
    );

    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.code).toBe('FORBIDDEN');
  });

  it('rejects live keys that do not have full scope', async () => {
    await db.prepare(`UPDATE api_keys SET scopes = ? WHERE id = ?`).bind(JSON.stringify(['decisions:read']), 'key-prod-001').run();

    const res = await gate({ action: 'Document the integration setup for the SDK' });

    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.code).toBe('FORBIDDEN');
  });

  it('bounds context inspection without choking on oversized payload hints', async () => {
    const res = await gate({
      action: 'Document the integration setup for the SDK',
      context: {
        notes: 'x'.repeat(20000),
        nested: Array.from({ length: 100 }, (_, i) => ({ i, value: 'y'.repeat(1000) })),
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.allow).toBe(true);
    expect(body.data.risk_level).toBe('low');
  });
});
