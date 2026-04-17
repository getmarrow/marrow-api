import { describe, it, expect, beforeAll } from 'vitest';
import { setupTestDb } from './helpers';
import { FeedbackService } from '../services/feedback.service';
import { DecisionService } from '../services/decision.service';

describe('Tier 3: Outcome Feedback', () => {
  let db: D1Database;
  let feedbackService: FeedbackService;
  let decisionService: DecisionService;
  let testAccountId: string;
  let testDecisionId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    feedbackService = new FeedbackService(db);
    decisionService = new DecisionService(db);
    testAccountId = 'test-account-' + Date.now();

    // Create test account
    await db
      .prepare('INSERT INTO accounts (id, name, email, tier) VALUES (?, ?, ?, ?)')
      .bind(testAccountId, 'Test', 'test@example.com', 'free')
      .run();

    // Create test decision
    testDecisionId = 'test-decision-' + Date.now();
    await db
      .prepare(
        'INSERT INTO decisions (id, account_id, decision_type, context, outcome, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        testDecisionId,
        testAccountId,
        'test-type',
        JSON.stringify({ key: 'value' }),
        'test outcome',
        0.5,
        'private',
        new Date().toISOString(),
        new Date().toISOString()
      )
      .run();
  });

  it('should record outcome with success=true', async () => {
    const result = await feedbackService.recordOutcome(testDecisionId, testAccountId, true, 'Great outcome!');
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.feedback).toBe('Great outcome!');
  });

  it('should record outcome with success=false', async () => {
    const decisionId = 'test-decision-fail-' + Date.now();
    await db
      .prepare(
        'INSERT INTO decisions (id, account_id, decision_type, context, outcome, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(decisionId, testAccountId, 'test-type', JSON.stringify({}), 'outcome', 0.5, 'private', new Date().toISOString(), new Date().toISOString())
      .run();

    const result = await feedbackService.recordOutcome(decisionId, testAccountId, false, 'Poor outcome');
    expect(result.success).toBe(false);
  });

  it('should prevent duplicate outcomes', async () => {
    const decisionId = 'test-decision-dup-' + Date.now();
    await db
      .prepare(
        'INSERT INTO decisions (id, account_id, decision_type, context, outcome, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(decisionId, testAccountId, 'test-type', JSON.stringify({}), 'outcome', 0.5, 'private', new Date().toISOString(), new Date().toISOString())
      .run();

    await feedbackService.recordOutcome(decisionId, testAccountId, true);
    
    try {
      await feedbackService.recordOutcome(decisionId, testAccountId, true);
      expect.fail('Should have thrown error');
    } catch (e) {
      expect((e as Error).message).toContain('already recorded');
    }
  });

  it('should retrieve outcome history', async () => {
    const history = await feedbackService.getOutcomeHistory(testAccountId);
    expect(history.length).toBeGreaterThan(0);
  });

  it('should calculate success metrics', async () => {
    const metrics = await feedbackService.getSuccessMetrics(testAccountId);
    expect(metrics).toBeDefined();
    expect(Array.isArray(metrics)).toBe(true);
  });

  it('should enforce account isolation', async () => {
    const otherAccountId = 'other-account-' + Date.now();
    await db
      .prepare('INSERT INTO accounts (id, name, email, tier) VALUES (?, ?, ?, ?)')
      .bind(otherAccountId, 'Other', 'other@example.com', 'free')
      .run();

    try {
      await feedbackService.recordOutcome(testDecisionId, otherAccountId, true);
      expect.fail('Should not allow other account to record outcome');
    } catch (e) {
      expect((e as Error).message).toContain('unauthorized');
    }
  });

  it('should calculate success rate', async () => {
    const rate = await feedbackService.calculateSuccessRate(testAccountId);
    expect(typeof rate).toBe('number');
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(1);
  });

  it('should get outcome by decision', async () => {
    const outcome = await feedbackService.getOutcome(testDecisionId, testAccountId);
    expect(outcome).toBeDefined();
    expect(outcome?.decision_id).toBe(testDecisionId);
  });

  it('should support detailed feedback', async () => {
    const decisionId = 'test-decision-details-' + Date.now();
    await db
      .prepare(
        'INSERT INTO decisions (id, account_id, decision_type, context, outcome, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(decisionId, testAccountId, 'test-type', JSON.stringify({}), 'outcome', 0.5, 'private', new Date().toISOString(), new Date().toISOString())
      .run();

    const details = { metrics: { precision: 0.95, recall: 0.87 }, comment: 'Exceeded expectations' };
    const result = await feedbackService.recordOutcome(decisionId, testAccountId, true, 'Excellent', details);
    expect(result.details).toEqual(details);
  });
});
