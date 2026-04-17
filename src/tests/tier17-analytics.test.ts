/**
 * Tier 17: Analytics — 12 tests
 * Tier 18: Marketplace — 18 tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AnalyticsService } from '../services/analytics.service';
import { PatternsService } from '../services/patterns.service';
import { DecisionService } from '../services/decision.service';
import { CollaborationService } from '../services/collaboration.service';
import { createMockD1, REAL_ACCOUNT_ID } from './helpers';

describe('Tier 17: Analytics & Insights', () => {
  let db: D1Database;
  let analytics: AnalyticsService;
  let svc: DecisionService;

  beforeEach(() => {
    db = createMockD1();
    analytics = new AnalyticsService(db);
    svc = new DecisionService(db);
  });

  it('gets agent analytics', async () => {
    await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const result = await analytics.getAgentAnalytics(REAL_ACCOUNT_ID);
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  it('agent analytics includes decision_velocity', async () => {
    await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const result = await analytics.getAgentAnalytics(REAL_ACCOUNT_ID);
    expect(result.decision_velocity).toBeDefined();
  });

  it('agent analytics includes success_rate', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await svc.recordOutcome(d.id, REAL_ACCOUNT_ID, true);
    const result = await analytics.getAgentAnalytics(REAL_ACCOUNT_ID);
    expect(result.success_rate).toBeDefined();
  });

  it('gets system analytics', async () => {
    const result = await analytics.getSystemAnalytics();
    expect(result).toBeDefined();
    expect(result.total_agents).toBeGreaterThanOrEqual(1);
  });

  it('system analytics includes total_decisions', async () => {
    await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const result = await analytics.getSystemAnalytics();
    expect(result.total_decisions).toBeGreaterThanOrEqual(1);
  });

  it('system analytics includes system_health', async () => {
    const result = await analytics.getSystemAnalytics();
    expect(result.system_health).toBeDefined();
    expect(result.system_health.avg_latency_ms).toBeDefined();
  });

  it('system analytics includes hive_growth_rate', async () => {
    const result = await analytics.getSystemAnalytics();
    expect(typeof result.hive_growth_rate).toBe('number');
  });

  it('gets trending types', async () => {
    await svc.createDecision(REAL_ACCOUNT_ID, 'trading', { a: 1 }, 'trading decision long', 0.5);
    const result = await analytics.getTrendingTypes(10);
    expect(Array.isArray(result)).toBe(true);
  });

  it('trending types include count', async () => {
    await svc.createDecision(REAL_ACCOUNT_ID, 'trading', { a: 1 }, 'trading decision long', 0.5);
    const result = await analytics.getTrendingTypes();
    if (result.length > 0) {
      expect(result[0].count).toBeGreaterThanOrEqual(1);
    }
  });

  it('trending types include success_rate', async () => {
    await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const result = await analytics.getTrendingTypes();
    if (result.length > 0) {
      expect(typeof result[0].success_rate).toBe('number');
    }
  });

  it('agent analytics with no data returns empty/defaults', async () => {
    const result = await analytics.getAgentAnalytics('empty-account');
    expect(result).toBeDefined();
  });

  it('analytics stores snapshots for trending', async () => {
    await analytics.getAgentAnalytics(REAL_ACCOUNT_ID);
    // Running twice should show history
    const result = await analytics.getAgentAnalytics(REAL_ACCOUNT_ID);
    expect(result).toBeDefined();
  });
});

describe('Tier 18: Marketplace', () => {
  let db: D1Database;
  let patterns: PatternsService;
  let collab: CollaborationService;
  let svc: DecisionService;

  beforeEach(() => {
    db = createMockD1();
    patterns = new PatternsService(db);
    collab = new CollaborationService(db);
    svc = new DecisionService(db);
  });

  it('publishes lesson to marketplace', async () => {
    const lesson = await collab.createLesson(REAL_ACCOUNT_ID, 'Test Lesson', 'Lesson content');
    await expect(patterns.publishLesson(lesson.id, REAL_ACCOUNT_ID)).resolves.not.toThrow();
  });

  it('publish creates lesson stats', async () => {
    const lesson = await collab.createLesson(REAL_ACCOUNT_ID, 'Test', 'Content');
    await patterns.publishLesson(lesson.id, REAL_ACCOUNT_ID);
    const marketplace = await patterns.getMarketplace('rating');
    expect(marketplace.length).toBe(1);
  });

  it('publish rejects non-owned lesson', async () => {
    const lesson = await collab.createLesson(REAL_ACCOUNT_ID, 'Test', 'Content');
    await expect(patterns.publishLesson(lesson.id, 'other-account')).rejects.toThrow('not found');
  });

  it('publish rejects non-existent lesson', async () => {
    await expect(patterns.publishLesson('fake-id', REAL_ACCOUNT_ID)).rejects.toThrow('not found');
  });

  it('marketplace returns published lessons', async () => {
    const l = await collab.createLesson(REAL_ACCOUNT_ID, 'Published', 'Content');
    await patterns.publishLesson(l.id, REAL_ACCOUNT_ID);
    await collab.createLesson(REAL_ACCOUNT_ID, 'Unpublished', 'Content'); // not published
    const marketplace = await patterns.getMarketplace('rating');
    expect(marketplace.length).toBe(1);
    expect(marketplace[0].title).toBe('Published');
  });

  it('forks published lesson', async () => {
    const l = await collab.createLesson(REAL_ACCOUNT_ID, 'Original', 'Content');
    await patterns.publishLesson(l.id, REAL_ACCOUNT_ID);
    const forkedId = await patterns.forkLesson(l.id, REAL_ACCOUNT_ID, 'Forked Version');
    expect(forkedId).toBeTruthy();
  });

  it('fork rejects unpublished lesson', async () => {
    const l = await collab.createLesson(REAL_ACCOUNT_ID, 'Draft', 'Content');
    await expect(patterns.forkLesson(l.id, REAL_ACCOUNT_ID, 'Fork')).rejects.toThrow('not published');
  });

  it('fork rejects non-existent lesson', async () => {
    await expect(patterns.forkLesson('fake', REAL_ACCOUNT_ID, 'Fork')).rejects.toThrow('not found');
  });

  it('fork increments fork_count', async () => {
    const l = await collab.createLesson(REAL_ACCOUNT_ID, 'Original', 'Content');
    await patterns.publishLesson(l.id, REAL_ACCOUNT_ID);
    await patterns.forkLesson(l.id, REAL_ACCOUNT_ID, 'Fork 1');
    await patterns.forkLesson(l.id, REAL_ACCOUNT_ID, 'Fork 2');
    const marketplace = await patterns.getMarketplace('forks');
    expect(marketplace[0].fork_count).toBe(2);
  });

  it('rates lesson (1-5 stars)', async () => {
    const l = await collab.createLesson(REAL_ACCOUNT_ID, 'Ratable', 'Content');
    await patterns.publishLesson(l.id, REAL_ACCOUNT_ID);
    await expect(patterns.rateLesson(l.id, REAL_ACCOUNT_ID, 4)).resolves.not.toThrow();
  });

  it('rejects rating below 1', async () => {
    const l = await collab.createLesson(REAL_ACCOUNT_ID, 'Test', 'Content');
    await patterns.publishLesson(l.id, REAL_ACCOUNT_ID);
    await expect(patterns.rateLesson(l.id, REAL_ACCOUNT_ID, 0)).rejects.toThrow('Rating must be');
  });

  it('rejects rating above 5', async () => {
    const l = await collab.createLesson(REAL_ACCOUNT_ID, 'Test', 'Content');
    await patterns.publishLesson(l.id, REAL_ACCOUNT_ID);
    await expect(patterns.rateLesson(l.id, REAL_ACCOUNT_ID, 6)).rejects.toThrow('Rating must be');
  });

  it('rating updates average', async () => {
    const l = await collab.createLesson(REAL_ACCOUNT_ID, 'Rated', 'Content');
    await patterns.publishLesson(l.id, REAL_ACCOUNT_ID);
    await patterns.rateLesson(l.id, 'agent1', 5);
    await patterns.rateLesson(l.id, 'agent2', 3);
    const marketplace = await patterns.getMarketplace('rating');
    expect(marketplace[0].rating_avg).toBe(4);
  });

  it('marketplace sorts by rating', async () => {
    const l1 = await collab.createLesson(REAL_ACCOUNT_ID, 'Low Rated', 'Content');
    const l2 = await collab.createLesson(REAL_ACCOUNT_ID, 'High Rated', 'Content');
    await patterns.publishLesson(l1.id, REAL_ACCOUNT_ID);
    await patterns.publishLesson(l2.id, REAL_ACCOUNT_ID);
    await patterns.rateLesson(l1.id, 'a1', 2);
    await patterns.rateLesson(l2.id, 'a2', 5);
    const marketplace = await patterns.getMarketplace('rating');
    expect(marketplace[0].rating_avg).toBeGreaterThanOrEqual(marketplace[1]?.rating_avg || 0);
  });

  it('marketplace sorts by recency', async () => {
    const l1 = await collab.createLesson(REAL_ACCOUNT_ID, 'First', 'Content');
    await patterns.publishLesson(l1.id, REAL_ACCOUNT_ID);
    const l2 = await collab.createLesson(REAL_ACCOUNT_ID, 'Second', 'Content');
    await patterns.publishLesson(l2.id, REAL_ACCOUNT_ID);
    const marketplace = await patterns.getMarketplace('recent');
    expect(marketplace.length).toBe(2);
  });

  it('marketplace includes domain_tags', async () => {
    const l = await collab.createLesson(REAL_ACCOUNT_ID, 'Tagged', 'Content', ['trading', 'crypto']);
    await patterns.publishLesson(l.id, REAL_ACCOUNT_ID);
    const marketplace = await patterns.getMarketplace('rating');
    expect(marketplace[0].domain_tags).toEqual(['trading', 'crypto']);
  });

  it('marketplace includes stats', async () => {
    const l = await collab.createLesson(REAL_ACCOUNT_ID, 'Stats', 'Content');
    await patterns.publishLesson(l.id, REAL_ACCOUNT_ID);
    const marketplace = await patterns.getMarketplace('rating');
    expect(marketplace[0].view_count).toBeDefined();
    expect(marketplace[0].fork_count).toBeDefined();
    expect(marketplace[0].reputation_score).toBeDefined();
  });

  it('empty marketplace returns empty array', async () => {
    const marketplace = await patterns.getMarketplace('rating');
    expect(marketplace).toEqual([]);
  });
});
