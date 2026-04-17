/**
 * Agent API Tests — /v1/agent/think + /v1/agent/commit
 * 2-call pattern: all 20 tiers as one
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, REAL_API_KEY, REAL_ACCOUNT_ID } from './helpers';
import { WorkflowService } from '../workflow';

describe('Agent API — /v1/agent/think', () => {
  let db: D1Database;
  let workflow: WorkflowService;

  beforeEach(async () => {
    db = await setupTestDb();
    workflow = new WorkflowService(db);
  });

  describe('think: input validation', () => {
    it('should return decision_id for valid action', async () => {
      const result = await workflow.before(
        { decision_type: 'implementation', action: 'deploying auth fix', description: 'deploying auth fix' },
        REAL_ACCOUNT_ID
      );

      expect(result).toBeDefined();
      expect(result.decision_id).toBeDefined();
      expect(typeof result.decision_id).toBe('string');
      expect(result.decision_id.length).toBeGreaterThan(0);
    });

    it('should work with default type (general)', async () => {
      const result = await workflow.before(
        { decision_type: 'general', action: 'generic action', description: 'generic action' },
        REAL_ACCOUNT_ID
      );

      expect(result.decision_id).toBeDefined();
    });

    it('should accept all supported types', async () => {
      const types = ['implementation', 'security', 'architecture', 'process', 'general'];
      for (const type of types) {
        const result = await workflow.before(
          { decision_type: type, action: `test ${type}`, description: `test ${type}` },
          REAL_ACCOUNT_ID
        );
        expect(result.decision_id).toBeDefined();
      }
    });
  });

  describe('think: intelligence response shape', () => {
    let result: Awaited<ReturnType<WorkflowService['before']>>;

    beforeEach(async () => {
      result = await workflow.before(
        { decision_type: 'implementation', action: 'deploying new feature', description: 'deploying new feature' },
        REAL_ACCOUNT_ID
      );
    });

    it('should return similar_decisions array (T7)', () => {
      expect(Array.isArray(result.similar_decisions)).toBe(true);
    });

    it('should return patterns array (T8)', () => {
      expect(Array.isArray(result.patterns)).toBe(true);
    });

    it('should return bootstrap_templates array (T11)', () => {
      expect(Array.isArray(result.bootstrap_templates)).toBe(true);
    });

    it('should return shared_context array (T4)', () => {
      expect(Array.isArray(result.shared_context)).toBe(true);
    });

    it('should return current_success_rate number (T17)', () => {
      expect(typeof result.current_success_rate).toBe('number');
      expect(result.current_success_rate).toBeGreaterThanOrEqual(0);
      expect(result.current_success_rate).toBeLessThanOrEqual(1);
    });

    it('should return priority_score number (T10)', () => {
      expect(typeof result.priority_score).toBe('number');
      expect(result.priority_score).toBeGreaterThanOrEqual(0);
      expect(result.priority_score).toBeLessThanOrEqual(1);
    });

    it('should return causal_context (null or object) (T6)', () => {
      expect(result.causal_context === null || typeof result.causal_context === 'object').toBe(true);
    });
  });
});

describe('Agent API — /v1/agent/commit', () => {
  let db: D1Database;
  let workflow: WorkflowService;
  let decision_id: string;

  beforeEach(async () => {
    db = await setupTestDb();
    workflow = new WorkflowService(db);

    // Create a decision first via think
    const before = await workflow.before(
      { decision_type: 'implementation', action: 'test action', description: 'test action' },
      REAL_ACCOUNT_ID
    );
    decision_id = before.decision_id;
  });

  describe('commit: records success', () => {
    it('should return committed: true on success', async () => {
      const result = await workflow.after(
        { decision_id, success: true, outcome: 'Deployed successfully' },
        REAL_ACCOUNT_ID
      );

      expect(result.outcome_recorded).toBe(true);
    });

    it('should return numeric success_rate (T17)', async () => {
      const result = await workflow.after(
        { decision_id, success: true, outcome: 'Deployed successfully' },
        REAL_ACCOUNT_ID
      );

      expect(typeof result.new_success_rate).toBe('number');
      expect(result.new_success_rate).toBeGreaterThanOrEqual(0);
      expect(result.new_success_rate).toBeLessThanOrEqual(1);
    });
  });

  describe('commit: records failure', () => {
    it('should handle failure gracefully', async () => {
      const result = await workflow.after(
        { decision_id, success: false, outcome: 'Deployment failed, rolled back' },
        REAL_ACCOUNT_ID
      );

      expect(result.outcome_recorded).toBe(true);
      expect(typeof result.new_success_rate).toBe('number');
    });
  });

  describe('commit: closes feedback loops', () => {
    it('should update consensus metrics (T12+T13)', async () => {
      const result = await workflow.after(
        { decision_id, success: true, outcome: 'Test outcome' },
        REAL_ACCOUNT_ID
      );

      expect(result.consensus).toBeDefined();
      expect(typeof result.consensus).toBe('object');
    });

    it('should confirm audit trail (T19)', async () => {
      const result = await workflow.after(
        { decision_id, success: true, outcome: 'Audit test' },
        REAL_ACCOUNT_ID
      );

      expect(typeof result.audit_confirmed).toBe('boolean');
    });

    it('should return hive signals (T5)', async () => {
      const result = await workflow.after(
        { decision_id, success: true, outcome: 'Hive signal test' },
        REAL_ACCOUNT_ID
      );

      expect(Array.isArray(result.hive_signals)).toBe(true);
    });

    it('should link causality when caused_by provided (T6)', async () => {
      // Create a second decision to link to
      const before2 = await workflow.before(
        { decision_type: 'implementation', action: 'follow-up action', description: 'follow-up' },
        REAL_ACCOUNT_ID
      );

      const result = await workflow.after(
        {
          decision_id,
          success: true,
          outcome: 'Causal test outcome',
          related_decision_id: before2.decision_id,
        },
        REAL_ACCOUNT_ID
      );

      expect(result.outcome_recorded).toBe(true);
    });
  });
});

describe('Agent API — End-to-End 2-call flow', () => {
  let db: D1Database;
  let workflow: WorkflowService;

  beforeEach(async () => {
    db = await setupTestDb();
    workflow = new WorkflowService(db);
  });

  it('should complete full think → act → commit cycle', async () => {
    // Step 1: think — get collective intelligence
    const think = await workflow.before(
      {
        decision_type: 'implementation',
        action: 'deploying auth fix',
        description: 'deploying auth fix',
      },
      REAL_ACCOUNT_ID
    );

    expect(think.decision_id).toBeDefined();
    const decision_id = think.decision_id;

    // intelligence is available for the agent to use
    expect(think.current_success_rate).toBeGreaterThanOrEqual(0);

    // Step 2: commit — close all feedback loops
    const commit = await workflow.after(
      {
        decision_id,
        success: true,
        outcome: 'Auth fix deployed successfully. All tests pass.',
      },
      REAL_ACCOUNT_ID
    );

    expect(commit.outcome_recorded).toBe(true);
    expect(typeof commit.new_success_rate).toBe('number');
  });

  it('should handle multiple agents in sequence (hive learning)', async () => {
    const decisions = [];

    for (let i = 0; i < 3; i++) {
      const think = await workflow.before(
        {
          decision_type: 'implementation',
          action: `agent_${i}_action`,
          description: `Agent ${i} acting`,
        },
        REAL_ACCOUNT_ID
      );

      decisions.push(think.decision_id);

      await workflow.after(
        {
          decision_id: think.decision_id,
          success: i !== 1, // agent 1 fails, others succeed
          outcome: `Agent ${i} ${i !== 1 ? 'succeeded' : 'failed'}`,
        },
        REAL_ACCOUNT_ID
      );
    }

    expect(decisions.length).toBe(3);
    expect(decisions.every(id => typeof id === 'string' && id.length > 0)).toBe(true);
  });
});
