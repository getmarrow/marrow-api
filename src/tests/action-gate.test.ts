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

  it('allows a low-risk agent action and echoes agent/session context', async () => {
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
    expect(body.data.agent_id).toBe('darvis');
    expect(body.data.session_id).toBe('session-123');
    expect(body.data.next.recommended_endpoint).toBe('/v1/workflow/before');
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
});
