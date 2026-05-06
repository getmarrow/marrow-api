import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../index';
import { createMockD1, REAL_API_KEY, TEST_ENCRYPTION_KEY } from './helpers';

describe('Route extraction wiring', () => {
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

  async function apiFetch(path: string, init: RequestInit = {}) {
    return worker.fetch(
      new Request(`https://api.getmarrow.ai${path}`, init),
      env(),
      ctx(),
    );
  }

  async function authedFetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${REAL_API_KEY}`);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return apiFetch(path, { ...init, headers });
  }

  it('keeps learned templates public and ahead of the template slug route', async () => {
    await db.prepare(`
      INSERT INTO learned_templates
        (id, template_id, pattern_cluster, steps, success_rate, confidence, usage_count, decision_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      'learned-1',
      'tpl_route_check',
      'route extraction',
      JSON.stringify(['inspect route table']),
      0.9,
      0.8,
      3,
      'engineering',
      new Date().toISOString(),
      new Date().toISOString(),
    ).run();

    const res = await apiFetch('/v1/templates/learned');
    expect(res.status).toBe(200);

    const body = await res.json() as {
      data: {
        templates: Array<{ template_id: string }>;
        refreshed: boolean;
      };
    };
    expect(body.data.refreshed).toBe(false);
    expect(body.data.templates).toHaveLength(1);
    expect(body.data.templates[0].template_id).toBe('tpl_route_check');
  });

  it('keeps authenticated template browsing on the extracted marketplace router', async () => {
    const res = await authedFetch('/v1/templates');
    expect(res.status).toBe(200);
  });

  it('keeps selected public utility routes unauthenticated', async () => {
    await expect(apiFetch('/health')).resolves.toMatchObject({ status: 200 });
    await expect(apiFetch('/version')).resolves.toMatchObject({ status: 200 });
  });
});
