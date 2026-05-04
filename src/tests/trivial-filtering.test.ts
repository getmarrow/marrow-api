import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../index';
import { classifyDecisionQuality } from '../middleware/auto-logger';
import { DecisionService } from '../services/decision.service';
import { PatternsService } from '../services/patterns.service';
import { WorkflowService } from '../workflow';
import { createMockD1, REAL_ACCOUNT_ID, REAL_API_KEY, TEST_ENCRYPTION_KEY } from './helpers';

describe('Trivial action filtering', () => {
  let db: D1Database;

  beforeEach(() => {
    db = createMockD1();
  });

  it('classifies deny-list heartbeat actions as trivial', () => {
    expect(classifyDecisionQuality('standing by')).toEqual({
      quality: 'trivial',
      filtered: true,
      reason: 'trivial_action',
    });
    expect(classifyDecisionQuality('session stable')).toEqual({
      quality: 'trivial',
      filtered: true,
      reason: 'trivial_action',
    });
  });

  it('flags short non-actionable text but keeps meaningful verb-led actions', () => {
    expect(classifyDecisionQuality('all good')).toEqual({
      quality: 'trivial',
      filtered: true,
      reason: 'trivial_action',
    });
    expect(classifyDecisionQuality('implement auth fix for prod')).toEqual({
      quality: null,
      filtered: false,
    });
  });

  it('does not false-positive longer legitimate actions that start with status words', () => {
    expect(classifyDecisionQuality('session check websocket retries after deploy')).toEqual({
      quality: null,
      filtered: false,
    });
    expect(classifyDecisionQuality('no issues reproducing the invoice race after patch')).toEqual({
      quality: null,
      filtered: false,
    });
  });

  it('persists trivial quality and skips embeddings', async () => {
    const ai = { run: vi.fn(async () => ({ data: [new Array(768).fill(0.1)] })) };
    const svc = new DecisionService(db, ai);

    const decision = await svc.createDecision(
      REAL_ACCOUNT_ID,
      'general',
      { action: 'standing by' },
      'standing by',
      0.5,
      'hive',
      'enterprise',
      false,
      null,
      null,
      'trivial'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stored = await svc.getDecision(decision.id, REAL_ACCOUNT_ID);
    expect(stored?.quality).toBe('trivial');
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('excludes trivial decisions from pattern discovery', async () => {
    const svc = new DecisionService(db);
    const patterns = new PatternsService(db);

    await svc.createDecision(REAL_ACCOUNT_ID, 'filter-test', { kind: 'trivial-1' }, 'standing by again for audit', 0.5, 'hive', 'enterprise', false, null, null, 'trivial');
    await svc.createDecision(REAL_ACCOUNT_ID, 'filter-test', { kind: 'trivial-2' }, 'session stable for audit trail', 0.5, 'hive', 'enterprise', false, null, null, 'trivial');
    await svc.createDecision(REAL_ACCOUNT_ID, 'filter-test', { kind: 'useful-1' }, 'implemented oauth callback retry handling', 0.5, 'hive');
    await svc.createDecision(REAL_ACCOUNT_ID, 'filter-test', { kind: 'useful-2' }, 'implemented oauth callback retry fallback', 0.5, 'hive');

    const discovered = await patterns.discoverPatterns(REAL_ACCOUNT_ID, 'filter-test');
    expect(discovered).toHaveLength(1);
  });

  it('excludes trivial decisions from hive priority reads', async () => {
    const svc = new DecisionService(db);
    const patterns = new PatternsService(db);

    await svc.createDecision(REAL_ACCOUNT_ID, 'priority-filter', { kind: 'trivial' }, 'standing by for audit only', 0.5, 'hive', 'enterprise', false, null, null, 'trivial');
    await svc.createDecision(REAL_ACCOUNT_ID, 'priority-filter', { kind: 'useful' }, 'implemented retry budget for key rotation flow', 0.9, 'hive');
    await patterns.recalculatePriorities(REAL_ACCOUNT_ID);

    const hive = await patterns.getHiveByPriority('priority-filter');
    expect(hive).toHaveLength(1);
    expect(String(hive[0].outcome)).toContain('implemented retry budget');
  });

  it('short-circuits workflow intelligence for trivial actions', async () => {
    const workflow = new WorkflowService(db);

    const result = await workflow.before(
      {
        decision_type: 'general',
        action: 'standing by',
        description: 'standing by',
        quality: 'trivial',
      },
      REAL_ACCOUNT_ID,
      'enterprise'
    );

    expect(result.similar_decisions).toEqual([]);
    expect(result.patterns).toEqual([]);
    expect(result.bootstrap_templates).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ pattern: 'trivial_action', severity: 'LOW' }),
    ]);
  });

  it('returns filtered feedback from /v1/agent/think and still logs the decision', async () => {
    const request = new Request('https://api.getmarrow.ai/v1/agent/think', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'standing by', type: 'general' }),
    });

    const response = await worker.fetch(
      request,
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
    expect(body.reason).toBe('trivial_action');
    expect(body.quality).toBe('trivial');

    const decisions = await new DecisionService(db).listDecisions(REAL_ACCOUNT_ID, { decision_type: 'general', limit: 5 });
    expect(decisions[0]?.quality).toBe('trivial');
    expect(decisions[0]?.context).toEqual({ action: 'standing by', description: 'standing by' });
  });
});
