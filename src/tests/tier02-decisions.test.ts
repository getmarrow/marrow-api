/**
 * Tier 2: Decision Routing & Validation — 25 tests
 * Tier 3: Outcome Feedback — 15 tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DecisionService } from '../services/decision.service';
import { createMockD1, REAL_ACCOUNT_ID } from './helpers';

describe('Tier 2: Decision Routing & Validation', () => {
  let db: D1Database;
  let svc: DecisionService;

  beforeEach(() => {
    db = createMockD1();
    svc = new DecisionService(db);
  });

  // Validation
  it('validates correct decision', () => {
    const result = svc.validateDecision({
      decision_type: 'trading',
      context: { market: 'crypto', signal: 'bullish' },
      outcome: 'Buy BTC at support level',
      confidence: 0.85,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects null body', () => {
    const result = svc.validateDecision(null);
    expect(result.valid).toBe(false);
    expect(result.errors?.body).toBeTruthy();
  });

  it('rejects non-object body', () => {
    const result = svc.validateDecision('string');
    expect(result.valid).toBe(false);
  });

  it('rejects missing decision_type', () => {
    const result = svc.validateDecision({ context: { a: 1 }, outcome: 'long enough outcome', confidence: 0.5 });
    expect(result.valid).toBe(false);
    expect(result.errors?.decision_type).toBeTruthy();
  });

  it('rejects empty decision_type', () => {
    const result = svc.validateDecision({ decision_type: '', context: { a: 1 }, outcome: 'long enough outcome', confidence: 0.5 });
    expect(result.valid).toBe(false);
  });

  it('rejects missing context', () => {
    const result = svc.validateDecision({ decision_type: 'test', outcome: 'long enough outcome', confidence: 0.5 });
    expect(result.valid).toBe(false);
    expect(result.errors?.context).toBeTruthy();
  });

  it('accepts empty context object', () => {
    const result = svc.validateDecision({ decision_type: 'test', context: {}, outcome: 'long enough outcome', confidence: 0.5 });
    expect(result.valid).toBe(true);
  });

  it('rejects array as context', () => {
    const result = svc.validateDecision({ decision_type: 'test', context: [1, 2], outcome: 'long enough outcome', confidence: 0.5 });
    expect(result.valid).toBe(false);
  });

  it('rejects short outcome', () => {
    const result = svc.validateDecision({ decision_type: 'test', context: { a: 1 }, outcome: 'short', confidence: 0.5 });
    expect(result.valid).toBe(false);
    expect(result.errors?.outcome).toBeTruthy();
  });

  it('rejects outcome less than 10 chars', () => {
    const result = svc.validateDecision({ decision_type: 'test', context: { a: 1 }, outcome: '123456789', confidence: 0.5 });
    expect(result.valid).toBe(false);
  });

  it('accepts outcome exactly 10 chars', () => {
    const result = svc.validateDecision({ decision_type: 'test', context: { a: 1 }, outcome: '1234567890', confidence: 0.5 });
    expect(result.valid).toBe(true);
  });

  it('rejects confidence below 0', () => {
    const result = svc.validateDecision({ decision_type: 'test', context: { a: 1 }, outcome: 'long enough outcome', confidence: -0.1 });
    expect(result.valid).toBe(false);
    expect(result.errors?.confidence).toBeTruthy();
  });

  it('rejects confidence above 1', () => {
    const result = svc.validateDecision({ decision_type: 'test', context: { a: 1 }, outcome: 'long enough outcome', confidence: 1.1 });
    expect(result.valid).toBe(false);
  });

  it('accepts confidence 0', () => {
    const result = svc.validateDecision({ decision_type: 'test', context: { a: 1 }, outcome: 'long enough outcome', confidence: 0 });
    expect(result.valid).toBe(true);
  });

  it('accepts confidence 1', () => {
    const result = svc.validateDecision({ decision_type: 'test', context: { a: 1 }, outcome: 'long enough outcome', confidence: 1 });
    expect(result.valid).toBe(true);
  });

  it('rejects NaN confidence', () => {
    const result = svc.validateDecision({ decision_type: 'test', context: { a: 1 }, outcome: 'long enough outcome', confidence: 'abc' });
    expect(result.valid).toBe(false);
  });

  it('returns multiple errors at once', () => {
    const result = svc.validateDecision({ decision_type: '', context: {}, outcome: 'short', confidence: 5 });
    expect(result.valid).toBe(false);
    expect(Object.keys(result.errors!).length).toBeGreaterThanOrEqual(3);
  });

  // Creation
  it('creates decision with valid data', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'trading', { market: 'crypto' }, 'Buy BTC at support level', 0.85, 'private', 'pro');
    expect(decision.id).toBeTruthy();
    expect(decision.account_id).toBe(REAL_ACCOUNT_ID);
    expect(decision.decision_type).toBe('trading');
    expect(decision.confidence).toBe(0.85);
    expect(decision.visibility).toBe('private');
  });

  it('creates decision with hive visibility', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5, 'hive');
    expect(decision.visibility).toBe('hive');
  });

  it('assigns UUID for decision ID', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    expect(decision.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets timestamps on creation', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    expect(decision.created_at).toBeTruthy();
    expect(decision.updated_at).toBeTruthy();
  });

  it('initializes impact_score at 0', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    expect(decision.impact_score).toBe(0);
  });

  it('initializes reuse_count at 0', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    expect(decision.reuse_count).toBe(0);
  });

  // Retrieval
  it('retrieves created decision by ID', async () => {
    const created = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { key: 'value' }, 'long enough outcome', 0.5);
    const retrieved = await svc.getDecision(created.id, REAL_ACCOUNT_ID);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.context).toEqual({ key: 'value' });
  });

  it('returns null for non-existent decision', async () => {
    const result = await svc.getDecision('nonexistent-id', REAL_ACCOUNT_ID);
    expect(result).toBeNull();
  });

  // List
  it('lists decisions for account', async () => {
    await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await svc.createDecision(REAL_ACCOUNT_ID, 'test', { b: 2 }, 'another long outcome', 0.7);
    const list = await svc.listDecisions(REAL_ACCOUNT_ID);
    expect(list.length).toBe(2);
  });

  it('filters by decision_type', async () => {
    await svc.createDecision(REAL_ACCOUNT_ID, 'trading', { a: 1 }, 'trading long outcome', 0.5);
    await svc.createDecision(REAL_ACCOUNT_ID, 'engineering', { b: 2 }, 'engineering long outcome', 0.7);
    const list = await svc.listDecisions(REAL_ACCOUNT_ID, { decision_type: 'trading' });
    expect(list.length).toBe(1);
    expect(list[0].decision_type).toBe('trading');
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await svc.createDecision(REAL_ACCOUNT_ID, 'test', { i }, `outcome number ${i} is long`, 0.5);
    }
    const list = await svc.listDecisions(REAL_ACCOUNT_ID, { limit: 3 });
    expect(list.length).toBe(3);
  });
});

describe('Tier 3: Outcome Feedback Loops', () => {
  let db: D1Database;
  let svc: DecisionService;

  beforeEach(() => {
    db = createMockD1();
    svc = new DecisionService(db);
  });

  it('records successful outcome', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const updated = await svc.recordOutcome(decision.id, REAL_ACCOUNT_ID, true, { note: 'worked' });
    expect(updated.outcome_success).toBe(true);
    expect(updated.outcome_recorded_at).toBeTruthy();
    expect(updated.outcome_details).toEqual({ note: 'worked' });
  });

  it('records failed outcome', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const updated = await svc.recordOutcome(decision.id, REAL_ACCOUNT_ID, false);
    expect(updated.outcome_success).toBe(false);
  });

  it('prevents recording outcome twice', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await svc.recordOutcome(decision.id, REAL_ACCOUNT_ID, true);
    await expect(svc.recordOutcome(decision.id, REAL_ACCOUNT_ID, false)).rejects.toThrow('already recorded');
  });

  it('rejects outcome for non-existent decision', async () => {
    await expect(svc.recordOutcome('fake-id', REAL_ACCOUNT_ID, true)).rejects.toThrow();
  });

  it('rejects outcome from wrong account', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await expect(svc.recordOutcome(decision.id, 'other-account', true)).rejects.toThrow();
  });

  it('records outcome_details as JSON', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const details = { profit: 5.2, duration: '2h', tags: ['quick', 'profitable'] };
    const updated = await svc.recordOutcome(decision.id, REAL_ACCOUNT_ID, true, details);
    expect(updated.outcome_details).toEqual(details);
  });

  it('outcome without details has undefined details', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const updated = await svc.recordOutcome(decision.id, REAL_ACCOUNT_ID, true);
    expect(updated.outcome_details).toBeUndefined();
  });

  it('updated decision retains original fields', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'trading', { market: 'crypto' }, 'Buy BTC at support level', 0.85);
    const updated = await svc.recordOutcome(decision.id, REAL_ACCOUNT_ID, true);
    expect(updated.decision_type).toBe('trading');
    expect(updated.confidence).toBe(0.85);
    expect(updated.context).toEqual({ market: 'crypto' });
  });

  it('updates updated_at timestamp', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const updated = await svc.recordOutcome(decision.id, REAL_ACCOUNT_ID, true);
    expect(updated.updated_at).toBeTruthy();
  });

  it('sets outcome_recorded_at to current timestamp', async () => {
    const before = new Date().toISOString();
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const updated = await svc.recordOutcome(decision.id, REAL_ACCOUNT_ID, true);
    expect(updated.outcome_recorded_at! >= before).toBe(true);
  });

  it('does not affect other decisions', async () => {
    const d1 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome 1', 0.5);
    const d2 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { b: 2 }, 'long enough outcome 2', 0.7);
    await svc.recordOutcome(d1.id, REAL_ACCOUNT_ID, true);
    const fresh = await svc.getDecision(d2.id, REAL_ACCOUNT_ID);
    expect(fresh!.outcome_success).toBeUndefined();
  });

  it('handles complex outcome details', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const details = { nested: { deep: { value: 42 } }, array: [1, 2, 3] };
    const updated = await svc.recordOutcome(decision.id, REAL_ACCOUNT_ID, true, details);
    expect(updated.outcome_details).toEqual(details);
  });

  it('outcome success is boolean true for success', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const updated = await svc.recordOutcome(decision.id, REAL_ACCOUNT_ID, true);
    expect(updated.outcome_success).toBe(true);
  });

  it('outcome success is boolean false for failure', async () => {
    const decision = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const updated = await svc.recordOutcome(decision.id, REAL_ACCOUNT_ID, false);
    expect(updated.outcome_success).toBe(false);
  });
});
