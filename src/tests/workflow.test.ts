/**
 * Workflow Tests (Unified 20-Tier Integration)
 * Tests: POST /v1/workflow/before, /v1/workflow/after, GET /v1/workflow/status
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, REAL_API_KEY, REAL_ACCOUNT_ID } from './helpers';
import { WorkflowService } from '../workflow';

describe('Workflow Service', () => {
  let db: D1Database;
  let workflow: WorkflowService;

  beforeEach(async () => {
    db = await setupTestDb();
    workflow = new WorkflowService(db);
  });

  describe('POST /v1/workflow/before', () => {
    it('should return decision_id and context from all tiers', async () => {
      const result = await workflow.before(
        {
          decision_type: 'implementation',
          action: 'deploy_auth_v2',
          description: 'Deploy new OAuth2 with fallback to SAML',
        },
        REAL_ACCOUNT_ID
      );

      expect(result).toBeDefined();
      expect(result.decision_id).toBeDefined();
      expect(typeof result.decision_id).toBe('string');
      expect(result.decision_id.length).toBeGreaterThan(0);

      // Check all expected fields present
      expect(result).toHaveProperty('similar_decisions');
      expect(result).toHaveProperty('bootstrap_templates');
      expect(result).toHaveProperty('patterns');
      expect(result).toHaveProperty('shared_context');
      expect(result).toHaveProperty('current_success_rate');
      expect(result).toHaveProperty('priority_score');
      expect(result).toHaveProperty('causal_context');
    });

    it('should return arrays for collection fields', async () => {
      const result = await workflow.before(
        {
          decision_type: 'design',
          action: 'choose_database',
          description: 'SQLite vs PostgreSQL',
        },
        REAL_ACCOUNT_ID
      );

      expect(Array.isArray(result.similar_decisions)).toBe(true);
      expect(Array.isArray(result.bootstrap_templates)).toBe(true);
      expect(Array.isArray(result.patterns)).toBe(true);
      expect(Array.isArray(result.shared_context)).toBe(true);
      expect(Array.isArray(result.hive_signals || [])).toBe(true);
    });

    it('should return numeric metrics', async () => {
      const result = await workflow.before(
        {
          decision_type: 'debug',
          action: 'fix_memory_leak',
          description: 'Investigating heap spike in /api/users',
        },
        REAL_ACCOUNT_ID
      );

      expect(typeof result.current_success_rate).toBe('number');
      expect(typeof result.priority_score).toBe('number');
      expect(result.current_success_rate).toBeGreaterThanOrEqual(0);
      expect(result.current_success_rate).toBeLessThanOrEqual(1);
      expect(result.priority_score).toBeGreaterThanOrEqual(0);
      expect(result.priority_score).toBeLessThanOrEqual(1);
    });

    it('should allow causal_context to be null', async () => {
      const result = await workflow.before(
        {
          decision_type: 'test',
          action: 'test_action',
          description: 'Test description',
        },
        REAL_ACCOUNT_ID
      );

      // causal_context is optional
      expect(result.causal_context === null || typeof result.causal_context === 'object').toBe(true);
    });

    it('should limit similar_decisions to top 3', async () => {
      const result = await workflow.before(
        {
          decision_type: 'implementation',
          action: 'test',
          description: 'test',
        },
        REAL_ACCOUNT_ID
      );

      expect(result.similar_decisions.length).toBeLessThanOrEqual(3);
    });
  });

  describe('POST /v1/workflow/after', () => {
    let decision_id: string;

    beforeEach(async () => {
      // Create a decision first
      const before_result = await workflow.before(
        {
          decision_type: 'implementation',
          action: 'deploy',
          description: 'Deploy test',
        },
        REAL_ACCOUNT_ID
      );
      decision_id = before_result.decision_id;
    });

    it('should record successful outcome', async () => {
      const result = await workflow.after(
        {
          decision_id,
          success: true,
          outcome: 'Deployed successfully with 0 errors',
        },
        REAL_ACCOUNT_ID
      );

      expect(result).toBeDefined();
      expect(result.outcome_recorded).toBe(true);
      expect(result).toHaveProperty('consensus');
      expect(result).toHaveProperty('new_success_rate');
      expect(result).toHaveProperty('velocity_trend');
      expect(result).toHaveProperty('hive_signals');
      expect(result).toHaveProperty('audit_confirmed');
    });

    it('should record failed outcome', async () => {
      const result = await workflow.after(
        {
          decision_id,
          success: false,
          outcome: 'Deployment failed: rollback triggered',
        },
        REAL_ACCOUNT_ID
      );

      expect(result.outcome_recorded).toBe(true);
      expect(typeof result.new_success_rate).toBe('number');
    });

    it('should update success_rate metrics', async () => {
      const result = await workflow.after(
        {
          decision_id,
          success: true,
          outcome: 'Task succeeded',
        },
        REAL_ACCOUNT_ID
      );

      expect(typeof result.new_success_rate).toBe('number');
      expect(result.new_success_rate).toBeGreaterThanOrEqual(0);
      expect(result.new_success_rate).toBeLessThanOrEqual(1);
    });

    it('should return velocity_trend', async () => {
      const result = await workflow.after(
        {
          decision_id,
          success: true,
          outcome: 'Test outcome',
        },
        REAL_ACCOUNT_ID
      );

      expect(typeof result.velocity_trend).toBe('string');
      expect(['increasing', 'decreasing', 'stable'].includes(result.velocity_trend)).toBe(true);
    });

    it('should return hive_signals array', async () => {
      const result = await workflow.after(
        {
          decision_id,
          success: true,
          outcome: 'Test outcome',
        },
        REAL_ACCOUNT_ID
      );

      expect(Array.isArray(result.hive_signals)).toBe(true);
    });

    it('should link causality if related_decision_id provided', async () => {
      // Create another decision
      const before2 = await workflow.before(
        {
          decision_type: 'follow_up',
          action: 'verify_deployment',
          description: 'Verify the deployment succeeded',
        },
        REAL_ACCOUNT_ID
      );

      const result = await workflow.after(
        {
          decision_id,
          success: true,
          outcome: 'First task completed',
          related_decision_id: before2.decision_id,
        },
        REAL_ACCOUNT_ID
      );

      expect(result.outcome_recorded).toBe(true);
    });

    it('should confirm audit trail', async () => {
      const result = await workflow.after(
        {
          decision_id,
          success: true,
          outcome: 'Audit test',
        },
        REAL_ACCOUNT_ID
      );

      expect(typeof result.audit_confirmed).toBe('boolean');
    });

    it('should return consensus object', async () => {
      const result = await workflow.after(
        {
          decision_id,
          success: true,
          outcome: 'Consensus test',
        },
        REAL_ACCOUNT_ID
      );

      expect(result.consensus).toBeDefined();
      expect(typeof result.consensus).toBe('object');
    });
  });

  describe('GET /v1/workflow/status', () => {
    it('should return full platform health snapshot', async () => {
      const result = await workflow.status();

      expect(result).toBeDefined();
      expect(result).toHaveProperty('analytics');
      expect(result).toHaveProperty('patterns_count');
      expect(result).toHaveProperty('templates_available');
      expect(result).toHaveProperty('audit_trail_count');
      expect(result).toHaveProperty('consensus_health');
      expect(result).toHaveProperty('snapshots_count');
      expect(result).toHaveProperty('api_version');
      expect(result).toHaveProperty('lessons_published');
      expect(result).toHaveProperty('restore_status');
      expect(result).toHaveProperty('stream_available');
      expect(result).toHaveProperty('timestamp');
    });

    it('should return numeric counts', async () => {
      const result = await workflow.status();

      expect(typeof result.patterns_count).toBe('number');
      expect(typeof result.templates_available).toBe('number');
      expect(typeof result.audit_trail_count).toBe('number');
      expect(typeof result.snapshots_count).toBe('number');
      expect(typeof result.lessons_published).toBe('number');

      expect(result.patterns_count).toBeGreaterThanOrEqual(0);
      expect(result.templates_available).toBeGreaterThanOrEqual(0);
      expect(result.audit_trail_count).toBeGreaterThanOrEqual(0);
    });

    it('should return stream_available as true', async () => {
      const result = await workflow.status();
      expect(result.stream_available).toBe(true);
    });

    it('should return API version string', async () => {
      const result = await workflow.status();
      expect(typeof result.api_version).toBe('string');
      expect(result.api_version.length).toBeGreaterThan(0);
    });

    it('should return valid ISO 8601 timestamp', async () => {
      const result = await workflow.status();
      const timestamp = new Date(result.timestamp);
      expect(timestamp.toISOString()).toBeDefined();
      expect(timestamp.getTime()).toBeLessThanOrEqual(Date.now() + 1000); // allow 1s drift
    });

    it('should return analytics object', async () => {
      const result = await workflow.status();
      expect(typeof result.analytics).toBe('object');
    });

    it('should return consensus_health object', async () => {
      const result = await workflow.status();
      expect(typeof result.consensus_health).toBe('object');
    });

    it('should return restore_status object', async () => {
      const result = await workflow.status();
      expect(typeof result.restore_status).toBe('object');
    });

    it('should handle all tiers gracefully', async () => {
      // Even if individual tiers fail, status should return complete object
      const result = await workflow.status();

      // All fields should exist, even if some have default values
      expect(Object.keys(result).length).toBeGreaterThanOrEqual(11);
      expect(result.patterns_count >= 0).toBe(true);
      expect(result.templates_available >= 0).toBe(true);
    });
  });

  describe('End-to-End Workflow', () => {
    it('should complete full before-task-after cycle', async () => {
      // 1. before()
      const before = await workflow.before(
        {
          decision_type: 'implementation',
          action: 'refactor_auth',
          description: 'Refactor authentication to use OAuth2',
        },
        REAL_ACCOUNT_ID
      );

      expect(before.decision_id).toBeDefined();
      const decision_id = before.decision_id;

      // 2. Simulate task (decision made and acted upon)
      // (in real world, this is where the actual work happens)

      // 3. after()
      const after = await workflow.after(
        {
          decision_id,
          success: true,
          outcome: 'Refactored successfully. Test coverage: 95%. Latency: -15%.',
        },
        REAL_ACCOUNT_ID
      );

      expect(after.outcome_recorded).toBe(true);
      expect(after.new_success_rate).toBeGreaterThanOrEqual(0);
      expect(after.audit_confirmed === true || typeof after.audit_confirmed === 'boolean').toBe(true);
    });

    it('should handle multiple sequential decisions', async () => {
      const decisions = [];

      for (let i = 0; i < 3; i++) {
        const before = await workflow.before(
          {
            decision_type: 'debug',
            action: `fix_issue_${i}`,
            description: `Fixing issue ${i}`,
          },
          REAL_ACCOUNT_ID
        );
        decisions.push(before.decision_id);

        await workflow.after(
          {
            decision_id: before.decision_id,
            success: i % 2 === 0, // alternate success/failure
            outcome: `Issue ${i} ${i % 2 === 0 ? 'fixed' : 'deferred'}`,
          },
          REAL_ACCOUNT_ID
        );
      }

      expect(decisions.length).toBe(3);
      expect(decisions.every(d => typeof d === 'string' && d.length > 0)).toBe(true);
    });
  });
});
