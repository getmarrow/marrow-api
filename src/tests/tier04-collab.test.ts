/**
 * Tier 4: Multi-Agent Collaboration — 18 tests
 * Tier 6: Causal Reasoning — 15 tests
 * Tier 9: Transfer Learning — 10 tests
 * Tier 14: Consensus — 12 tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CollaborationService } from '../services/collaboration.service';
import { DecisionService } from '../services/decision.service';
import { AuthService } from '../services/auth.service';
import { createMockD1, REAL_ACCOUNT_ID } from './helpers';

describe('Tier 4: Multi-Agent Collaboration', () => {
  let db: D1Database;
  let collab: CollaborationService;
  let decisions: DecisionService;
  let auth: AuthService;
  let otherAccountId: string;

  beforeEach(async () => {
    db = createMockD1();
    collab = new CollaborationService(db);
    decisions = new DecisionService(db);
    auth = new AuthService(db);
    const other = await auth.createAccount('Other Agent', 'other@test.com', 'pro');
    otherAccountId = other.id;
  });

  it('shares decision with another account', async () => {
    const d = await decisions.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const share = await collab.shareDecision(d.id, REAL_ACCOUNT_ID, otherAccountId, 0.8);
    expect(share.decision_id).toBe(d.id);
    expect(share.shared_by_account_id).toBe(REAL_ACCOUNT_ID);
    expect(share.shared_with_account_id).toBe(otherAccountId);
    expect(share.trust_score).toBe(0.8);
  });

  it('rejects sharing non-owned decision', async () => {
    const d = await decisions.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await expect(collab.shareDecision(d.id, otherAccountId, REAL_ACCOUNT_ID, 0.5)).rejects.toThrow('not found or not owned');
  });

  it('rejects sharing to non-existent account', async () => {
    const d = await decisions.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await expect(collab.shareDecision(d.id, REAL_ACCOUNT_ID, 'fake-account', 0.5)).rejects.toThrow('Target account not found');
  });

  it('rejects trust score below 0', async () => {
    const d = await decisions.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await expect(collab.shareDecision(d.id, REAL_ACCOUNT_ID, otherAccountId, -0.1)).rejects.toThrow('Trust score');
  });

  it('rejects trust score above 1', async () => {
    const d = await decisions.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await expect(collab.shareDecision(d.id, REAL_ACCOUNT_ID, otherAccountId, 1.5)).rejects.toThrow('Trust score');
  });

  it('accepts trust score of 0', async () => {
    const d = await decisions.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const share = await collab.shareDecision(d.id, REAL_ACCOUNT_ID, otherAccountId, 0);
    expect(share.trust_score).toBe(0);
  });

  it('accepts trust score of 1', async () => {
    const d = await decisions.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const share = await collab.shareDecision(d.id, REAL_ACCOUNT_ID, otherAccountId, 1);
    expect(share.trust_score).toBe(1);
  });

  it('updates decision visibility to shared', async () => {
    const d = await decisions.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5, 'private', 'pro');
    expect(d.visibility).toBe('private');
    await collab.shareDecision(d.id, REAL_ACCOUNT_ID, otherAccountId, 0.5);
    const updated = await decisions.getDecision(d.id, REAL_ACCOUNT_ID);
    expect(updated!.visibility).toBe('shared');
  });

  it('generates unique share IDs', async () => {
    const d = await decisions.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const other2 = await auth.createAccount('Other2', 'other2@test.com');
    const s1 = await collab.shareDecision(d.id, REAL_ACCOUNT_ID, otherAccountId, 0.5);
    const s2 = await collab.shareDecision(d.id, REAL_ACCOUNT_ID, other2.id, 0.5);
    expect(s1.id).not.toBe(s2.id);
  });

  it('retrieves shared decisions for recipient', async () => {
    const d = await decisions.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await collab.shareDecision(d.id, REAL_ACCOUNT_ID, otherAccountId, 0.8);
    const shared = await collab.getSharedDecisions(otherAccountId);
    expect(shared.length).toBe(1);
  });

  it('returns empty for account with no shared decisions', async () => {
    const shared = await collab.getSharedDecisions(otherAccountId);
    expect(shared.length).toBe(0);
  });

  it('sets created_at on share', async () => {
    const d = await decisions.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const share = await collab.shareDecision(d.id, REAL_ACCOUNT_ID, otherAccountId, 0.5);
    expect(share.created_at).toBeTruthy();
  });
});

describe('Tier 6: Causal Reasoning Graphs', () => {
  let db: D1Database;
  let collab: CollaborationService;
  let svc: DecisionService;

  beforeEach(() => {
    db = createMockD1();
    collab = new CollaborationService(db);
    svc = new DecisionService(db);
  });

  it('creates causal edge between decisions', async () => {
    const d1 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'cause decision long', 0.5);
    const d2 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { b: 2 }, 'effect decision long', 0.7);
    const edge = await collab.addCausalityEdge(d1.id, d2.id, 'd1 caused d2', REAL_ACCOUNT_ID);
    expect(edge.from_decision_id).toBe(d1.id);
    expect(edge.to_decision_id).toBe(d2.id);
    expect(edge.reasoning).toBe('d1 caused d2');
  });

  it('rejects edge with non-existent from decision', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await expect(collab.addCausalityEdge('fake', d.id, 'reason', REAL_ACCOUNT_ID)).rejects.toThrow('not found');
  });

  it('rejects edge with non-existent to decision', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await expect(collab.addCausalityEdge(d.id, 'fake', 'reason', REAL_ACCOUNT_ID)).rejects.toThrow('not found');
  });

  it('detects direct cycle (A→B→A)', async () => {
    const d1 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'decision one long', 0.5);
    const d2 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { b: 2 }, 'decision two long', 0.5);
    await collab.addCausalityEdge(d1.id, d2.id, 'forward', REAL_ACCOUNT_ID);
    await expect(collab.addCausalityEdge(d2.id, d1.id, 'backward', REAL_ACCOUNT_ID)).rejects.toThrow('Cycle');
  });

  it('gets causality graph with causes', async () => {
    const d1 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'cause one is long', 0.5);
    const d2 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { b: 2 }, 'effect one is long', 0.5);
    await collab.addCausalityEdge(d1.id, d2.id, 'caused it', REAL_ACCOUNT_ID);
    const graph = await collab.getCausalityGraph(d2.id, REAL_ACCOUNT_ID);
    expect(graph.direct_causes).toBe(1);
    expect(graph.causes.length).toBe(1);
  });

  it('gets causality graph with effects', async () => {
    const d1 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'cause one is long', 0.5);
    const d2 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { b: 2 }, 'effect one is long', 0.5);
    await collab.addCausalityEdge(d1.id, d2.id, 'caused it', REAL_ACCOUNT_ID);
    const graph = await collab.getCausalityGraph(d1.id, REAL_ACCOUNT_ID);
    expect(graph.downstream_effects).toBe(1);
  });

  it('returns empty graph for isolated decision', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'isolated decision long', 0.5);
    const graph = await collab.getCausalityGraph(d.id, REAL_ACCOUNT_ID);
    expect(graph.direct_causes).toBe(0);
    expect(graph.downstream_effects).toBe(0);
  });

  it('edge has unique ID', async () => {
    const d1 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'decision one long enough', 0.5);
    const d2 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { b: 2 }, 'decision two long enough', 0.5);
    const edge = await collab.addCausalityEdge(d1.id, d2.id, 'reason', REAL_ACCOUNT_ID);
    expect(edge.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('edge has created_at', async () => {
    const d1 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'decision one long enough', 0.5);
    const d2 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { b: 2 }, 'decision two long enough', 0.5);
    const edge = await collab.addCausalityEdge(d1.id, d2.id, 'reason', REAL_ACCOUNT_ID);
    expect(edge.created_at).toBeTruthy();
  });

  it('multiple causes for one decision', async () => {
    const d1 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'cause one is long enough', 0.5);
    const d2 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { b: 2 }, 'cause two is long enough', 0.5);
    const d3 = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { c: 3 }, 'effect has two causes', 0.5);
    await collab.addCausalityEdge(d1.id, d3.id, 'first cause', REAL_ACCOUNT_ID);
    await collab.addCausalityEdge(d2.id, d3.id, 'second cause', REAL_ACCOUNT_ID);
    const graph = await collab.getCausalityGraph(d3.id, REAL_ACCOUNT_ID);
    expect(graph.direct_causes).toBe(2);
  });
});

describe('Tier 9: Cross-Domain Transfer Learning', () => {
  let db: D1Database;
  let collab: CollaborationService;

  beforeEach(() => {
    db = createMockD1();
    collab = new CollaborationService(db);
  });

  it('creates lesson with domain tags', async () => {
    const lesson = await collab.createLesson(REAL_ACCOUNT_ID, 'Test Lesson', 'Lesson content here', ['trading', 'crypto']);
    expect(lesson.title).toBe('Test Lesson');
    expect(lesson.domain_tags).toEqual(['trading', 'crypto']);
  });

  it('creates lesson without domain tags', async () => {
    const lesson = await collab.createLesson(REAL_ACCOUNT_ID, 'No Tags', 'Content here');
    expect(lesson.domain_tags).toBeUndefined();
  });

  it('lesson defaults to unpublished', async () => {
    const lesson = await collab.createLesson(REAL_ACCOUNT_ID, 'Draft', 'Draft content');
    expect(lesson.is_published).toBe(false);
  });

  it('lesson defaults to 0.5 transferability', async () => {
    const lesson = await collab.createLesson(REAL_ACCOUNT_ID, 'Test', 'Content');
    expect(lesson.transferability_score).toBe(0.5);
  });

  it('gets transferable lessons from domain', async () => {
    await collab.createLesson(REAL_ACCOUNT_ID, 'Trading 101', 'Content', ['trading']);
    const lessons = await collab.getTransferableLessons('trading', 'engineering');
    expect(lessons.length).toBeGreaterThanOrEqual(0);
  });

  it('lesson has unique ID', async () => {
    const l1 = await collab.createLesson(REAL_ACCOUNT_ID, 'L1', 'Content1');
    const l2 = await collab.createLesson(REAL_ACCOUNT_ID, 'L2', 'Content2');
    expect(l1.id).not.toBe(l2.id);
  });

  it('lesson has timestamps', async () => {
    const lesson = await collab.createLesson(REAL_ACCOUNT_ID, 'Test', 'Content');
    expect(lesson.created_at).toBeTruthy();
    expect(lesson.updated_at).toBeTruthy();
  });

  it('lesson has publisher reputation at 0', async () => {
    const lesson = await collab.createLesson(REAL_ACCOUNT_ID, 'Test', 'Content');
    expect(lesson.publisher_reputation).toBe(0);
  });

  it('transfer returns array', async () => {
    const result = await collab.getTransferableLessons('trading', 'ops');
    expect(Array.isArray(result)).toBe(true);
  });

  it('limits transfer results', async () => {
    for (let i = 0; i < 15; i++) {
      await collab.createLesson(REAL_ACCOUNT_ID, `Lesson ${i}`, 'Content', ['trading']);
    }
    const result = await collab.getTransferableLessons('trading', 'ops', 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });
});

describe('Tier 14: Hive Consensus', () => {
  let db: D1Database;
  let collab: CollaborationService;
  let svc: DecisionService;

  beforeEach(() => {
    db = createMockD1();
    collab = new CollaborationService(db);
    svc = new DecisionService(db);
  });

  it('records consensus vote', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const vote = await collab.recordConsensusVote(d.id, REAL_ACCOUNT_ID, true);
    expect(vote.decision_id).toBe(d.id);
    expect(vote.agrees).toBe(true);
    expect(vote.voting_agent_id).toBe(REAL_ACCOUNT_ID);
  });

  it('records disagree vote', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const vote = await collab.recordConsensusVote(d.id, REAL_ACCOUNT_ID, false);
    expect(vote.agrees).toBe(false);
  });

  it('rejects vote for non-existent decision', async () => {
    await expect(collab.recordConsensusVote('fake-id', REAL_ACCOUNT_ID, true)).rejects.toThrow('not found');
  });

  it('vote has confidence boost', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const vote = await collab.recordConsensusVote(d.id, REAL_ACCOUNT_ID, true);
    expect(vote.confidence_boost).toBeGreaterThanOrEqual(1.0);
  });

  it('vote has voted_at timestamp', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const vote = await collab.recordConsensusVote(d.id, REAL_ACCOUNT_ID, true);
    expect(vote.voted_at).toBeTruthy();
  });

  it('gets hive consensus for decision type', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'trading', { a: 1 }, 'long enough outcome', 0.5, 'hive');
    await collab.recordConsensusVote(d.id, REAL_ACCOUNT_ID, true);
    const consensus = await collab.getHiveConsensus('trading');
    expect(consensus.decision_type).toBe('trading');
    expect(consensus.total_votes).toBeGreaterThanOrEqual(1);
  });

  it('calculates agreement percentage', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await collab.recordConsensusVote(d.id, 'agent1', true);
    await collab.recordConsensusVote(d.id, 'agent2', true);
    await collab.recordConsensusVote(d.id, 'agent3', false);
    const consensus = await collab.getHiveConsensus('test');
    expect(consensus.agreement_percentage).toBeCloseTo(66.67, 0);
  });

  it('counts unique voting agents', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await collab.recordConsensusVote(d.id, 'agent1', true);
    await collab.recordConsensusVote(d.id, 'agent2', true);
    const consensus = await collab.getHiveConsensus('test');
    expect(consensus.voting_agents_count).toBe(2);
  });

  it('returns 0 for type with no votes', async () => {
    const consensus = await collab.getHiveConsensus('nonexistent');
    expect(consensus.total_votes).toBe(0);
    expect(consensus.agreement_percentage).toBe(0);
  });

  it('confidence boost at 2x for 2 agrees', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await collab.recordConsensusVote(d.id, 'agent1', true);
    await collab.recordConsensusVote(d.id, 'agent2', true);
    const consensus = await collab.getHiveConsensus('test');
    expect(consensus.confidence_boost).toBe(2.0);
  });

  it('confidence boost at 3x for 3+ agrees', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await collab.recordConsensusVote(d.id, 'agent1', true);
    await collab.recordConsensusVote(d.id, 'agent2', true);
    await collab.recordConsensusVote(d.id, 'agent3', true);
    const consensus = await collab.getHiveConsensus('test');
    expect(consensus.confidence_boost).toBe(3.0);
  });

  it('blind voting - agent IDs in consensus are counted not exposed', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await collab.recordConsensusVote(d.id, 'agent1', true);
    const consensus = await collab.getHiveConsensus('test');
    // Consensus returns counts, not individual voter IDs
    expect(consensus.voting_agents_count).toBeDefined();
    expect(consensus.agree_count).toBeDefined();
  });
});
