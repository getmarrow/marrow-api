import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../index';
import { createMockD1, REAL_ACCOUNT_ID, REAL_API_KEY, TEST_ENCRYPTION_KEY } from './helpers';

describe('Fleet moat phase 2', () => {
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

  async function authedFetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${REAL_API_KEY}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return worker.fetch(new Request(`https://api.getmarrow.ai${path}`, { ...init, headers }), env(), ctx());
  }

  async function seedDecision(id: string, type: string, success: number, agentId = 'jarvis') {
    const ts = new Date().toISOString();
    await db.prepare(`
      INSERT INTO decisions
        (id, account_id, decision_type, context, outcome, confidence, visibility,
         outcome_success, outcome_recorded_at, session_id, agent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      REAL_ACCOUNT_ID,
      type,
      JSON.stringify({ action: `${type} production worker` }),
      success ? `${type} passed smoke test` : `${type} failed smoke test`,
      0.82,
      'private',
      success,
      ts,
      `${agentId}-session`,
      agentId,
      ts,
      ts,
    ).run();
  }

  async function seedOpenDecision(id: string, type: string, agentId = 'jarvis', action = `${type} production worker`, outcome = '') {
    const ts = new Date().toISOString();
    await db.prepare(`
      INSERT INTO decisions
        (id, account_id, decision_type, context, outcome, confidence, visibility,
         outcome_success, outcome_recorded_at, session_id, agent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      REAL_ACCOUNT_ID,
      type,
      JSON.stringify({ action }),
      outcome,
      0.82,
      'private',
      null,
      null,
      `${agentId}-session`,
      agentId,
      ts,
      ts,
    ).run();
  }

  async function bindPrimaryKeyToAgents(agentIds: string[]) {
    await db.prepare('UPDATE api_keys SET agent_ids = ? WHERE account_id = ?')
      .bind(agentIds.join(','), REAL_ACCOUNT_ID)
      .run();
  }

  it('records ranked fleet lessons and tracks reuse', async () => {
    const create = await authedFetch('/v1/fleet/lessons', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Dry run deploy first',
        summary: 'Run smoke tests before deploying production worker.',
        lesson_type: 'success',
        action_pattern: 'deploy worker',
        outcome_success: true,
        confidence: 0.9,
        tags: ['deploy', 'smoke'],
      }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as any;
    expect(created.data.lesson.score).toBeGreaterThan(0.7);

    const list = await authedFetch('/v1/fleet/lessons?query=deploy&limit=5');
    const listed = await list.json() as any;
    expect(list.status).toBe(200);
    expect(listed.data.count).toBe(1);

    const reuse = await authedFetch(`/v1/fleet/lessons/${created.data.lesson.id}/reuse`, { method: 'POST' });
    const reused = await reuse.json() as any;
    expect(reused.data.lesson.reuse_count).toBe(1);
  });

  it('adds relevant lessons and deployment playbooks to risk gate responses', async () => {
    await authedFetch('/v1/fleet/lessons', {
      method: 'POST',
      body: JSON.stringify({
        summary: 'Always keep rollback command ready before production deploy.',
        lesson_type: 'deploy',
        action_pattern: 'production deploy',
      }),
    });
    await authedFetch('/v1/fleet/deployment-memory', {
      method: 'POST',
      body: JSON.stringify({
        release_id: 'release-1',
        status: 'verified',
        tests: ['npm test'],
        smoke_result: 'HTTP 200',
        rollback_plan: 'wrangler rollback',
      }),
    });

    const gate = await authedFetch('/v1/workflow/gate', {
      method: 'POST',
      headers: { 'X-Marrow-Agent-Id': 'jarvis' },
      body: JSON.stringify({ action: 'deploy production worker', risk_tolerance: 'medium' }),
    });
    const body = await gate.json() as any;
    expect(gate.status).toBe(200);
    expect(body.data.gate_event_id).toBeTruthy();
    expect(body.data.decision).toBe('review_required');
    expect(body.data.prior_lessons.length).toBeGreaterThan(0);
    expect(body.data.deployment_playbooks.length).toBeGreaterThan(0);
  });

  it('redacts token-shaped values before persisting workflow gate actions', async () => {
    const tokenTail = 'abcdefghijklmnopqrstuvwxyz1234567890';
    const githubToken = `ghp_${tokenTail}`;
    const marrowToken = `mrw_live_${tokenTail}`;
    const openAiToken = `sk-${tokenTail}`;
    const fakeNpmToken = `npm_${tokenTail}`;
    const gate = await authedFetch('/v1/workflow/gate', {
      method: 'POST',
      body: JSON.stringify({
        action: `rotate --token ${githubToken} and MARROW_API_KEY=${marrowToken}`,
        context: {
          authorization: `Bearer ${openAiToken}`,
          nested: { npmToken: fakeNpmToken },
        },
        risk_tolerance: 'high',
      }),
    });
    const body = await gate.json() as any;
    expect(gate.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');

    const stored = await db.prepare('SELECT action FROM risk_gate_events WHERE id = ?')
      .bind(body.data.gate_event_id)
      .first<{ action: string }>();
    expect(stored?.action).toContain('[redacted]');
    expect(stored?.action).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
  });

  it('tracks handoffs, deployment memory, permissions, and agent performance', async () => {
    await seedDecision('deploy-ok', 'deploy', 1);
    await seedDecision('audit-fail', 'audit', 0, 'barvis');

    const handoffRes = await authedFetch('/v1/fleet/handoffs', {
      method: 'POST',
      body: JSON.stringify({
        to_agent_id: 'barvis',
        task: 'Run security audit and report findings.',
        stale_after_seconds: 120,
      }),
    });
    const handoffBody = await handoffRes.json() as any;
    expect(handoffRes.status).toBe(201);

    const patch = await authedFetch(`/v1/fleet/handoffs/${handoffBody.data.handoff.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'complete', result_summary: 'Audit passed.' }),
    });
    expect(patch.status).toBe(200);

    const permission = await authedFetch('/v1/fleet/memory-permissions', {
      method: 'PUT',
      body: JSON.stringify({ agent_id: 'barvis', permission: 'read-only', scope: 'security' }),
    });
    expect(permission.status).toBe(200);

    const updatedPermission = await authedFetch('/v1/fleet/memory-permissions', {
      method: 'PUT',
      body: JSON.stringify({ agent_id: 'barvis', permission: 'shared', scope: 'security' }),
    });
    expect(updatedPermission.status).toBe(200);

    const permissions = await authedFetch('/v1/fleet/memory-permissions?agent_id=barvis');
    const permissionsBody = await permissions.json() as any;
    expect(permissions.status).toBe(200);
    expect(permissionsBody.data.count).toBe(1);
    expect(permissionsBody.data.permissions[0].permission).toBe('shared');

    const gate = await authedFetch('/v1/workflow/gate', {
      method: 'POST',
      headers: { 'X-Marrow-Agent-Id': 'jarvis' },
      body: JSON.stringify({ action: 'deploy production worker with smoke test proof missing', risk_tolerance: 'medium' }),
    });
    expect(gate.status).toBe(200);

    const perf = await authedFetch('/v1/analytics/agent-performance?period=7');
    const perfBody = await perf.json() as any;
    expect(perf.status).toBe(200);
    expect(perfBody.data.failed_patterns[0].decision_type).toBe('audit');
    expect(perfBody.data.agent_reliability_score).toBeGreaterThan(0);
    expect(perfBody.data.avoided_repeated_mistakes).toBeGreaterThanOrEqual(0);
    expect(perfBody.data.prevented_bad_actions).toBeGreaterThan(0);
    expect(perfBody.data.blocked_risky_actions).toBeGreaterThan(0);
    expect(perfBody.data.blocked_risky_action_examples[0]).toMatchObject({
      action_type: 'deploy',
      risk_level: 'high',
      decision: 'review_required',
      proof_safe: true,
    });
    expect(JSON.stringify(perfBody.data.blocked_risky_action_examples)).not.toContain('smoke test proof missing');
    expect(perfBody.data.token_time_saved_estimate.estimated_tokens_saved).toBeGreaterThan(0);
    expect(perfBody.data.reliability_trend.direction).toMatch(/improving|declining|flat/);
    expect(perfBody.data.proof_summary.owner_summary).toContain('Reliability');
  });

  it('enforces agent-bound keys and redacts sensitive fleet content', async () => {
    await authedFetch('/v1/fleet/lessons', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: 'barvis',
        summary: 'Barvis-only audit lesson',
        visibility: 'private',
      }),
    });

    await authedFetch('/v1/fleet/memory-permissions', {
      method: 'PUT',
      body: JSON.stringify({ agent_id: 'jarvis', permission: 'contribute-only', scope: 'fleet' }),
    });

    await bindPrimaryKeyToAgents(['jarvis']);

    const spoofed = await authedFetch('/v1/fleet/lessons', {
      method: 'POST',
      headers: { 'X-Marrow-Agent-Id': 'barvis' },
      body: JSON.stringify({
        agent_id: 'barvis',
        summary: 'Jarvis should not spoof Barvis',
      }),
    });
    expect(spoofed.status).toBe(403);

    const hidden = await authedFetch('/v1/fleet/lessons?agent_id=barvis');
    expect(hidden.status).toBe(403);

    const memory = await authedFetch('/v1/fleet/deployment-memory', {
      method: 'POST',
      headers: { 'X-Marrow-Agent-Id': 'jarvis' },
      body: JSON.stringify({
        status: 'verified',
        pr_url: 'https://user:pass@example.com/deploy?token=secret',
        smoke_result: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
        rollback_plan: 'password=supersecretvalue',
      }),
    });
    const memoryBody = await memory.json() as any;
    expect(memory.status).toBe(201);
    expect(memoryBody.data.memory.agent_id).toBe('jarvis');
    expect(memoryBody.data.memory.pr_url).toBe('https://example.com/deploy');
    expect(memoryBody.data.memory.smoke_result).toContain('[redacted');
    expect(memoryBody.data.memory.rollback_plan).toContain('[redacted');

    const gate = await authedFetch('/v1/workflow/gate', {
      method: 'POST',
      headers: { 'X-Marrow-Agent-Id': 'barvis' },
      body: JSON.stringify({ action: 'deploy production worker' }),
    });
    const gateBody = await gate.json() as any;
    expect(gate.status).toBe(200);
    expect(gateBody.data.agent_id).toBe('jarvis');
  });

  it('blocks agent-bound outcome commits for other agents and keeps auto-learned lessons private/categorical', async () => {
    await seedOpenDecision('barvis-open', 'audit', 'barvis', 'audit private-project-alpha', 'private barvis outcome');
    await seedOpenDecision('jarvis-open', 'deploy', 'jarvis', 'deploy private-project-beta', 'private jarvis outcome');
    await bindPrimaryKeyToAgents(['jarvis']);

    const foreignWorkflowCommit = await authedFetch('/v1/workflow/after', {
      method: 'POST',
      body: JSON.stringify({
        decision_id: 'barvis-open',
        success: true,
        outcome: 'barvis private outcome should not be writable',
      }),
    });
    expect(foreignWorkflowCommit.status).toBe(403);

    const foreignAgentCommit = await authedFetch('/v1/agent/commit', {
      method: 'POST',
      body: JSON.stringify({
        decision_id: 'barvis-open',
        success: true,
        outcome: 'barvis private outcome should not be writable',
      }),
    });
    expect(foreignAgentCommit.status).toBe(403);

    const ownCommit = await authedFetch('/v1/workflow/after', {
      method: 'POST',
      body: JSON.stringify({
        decision_id: 'jarvis-open',
        success: false,
        outcome: 'private-project-beta stack trace must not become lesson text',
      }),
    });
    const ownBody = await ownCommit.json() as any;
    expect(ownCommit.status).toBe(200);
    expect(ownBody.data.fleet_lesson).toBeTruthy();
    expect(ownBody.data.fleet_lesson.visibility).toBe('private');
    expect(JSON.stringify(ownBody)).not.toContain('private-project-beta');
    expect(ownBody.data.fleet_lesson.summary).toContain('Failed deploy outcome recorded');

    const lessons = await authedFetch('/v1/fleet/lessons?query=deploy');
    const lessonsBody = await lessons.json() as any;
    expect(lessons.status).toBe(200);
    expect(JSON.stringify(lessonsBody)).not.toContain('private-project-beta');
  });
});
