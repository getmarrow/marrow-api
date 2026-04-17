import { describe, it, expect, beforeAll } from 'vitest';
import { setupTestDb } from './helpers';
import { CausalityService } from '../services/causality.service';

describe('Tier 6: Causal Reasoning', () => {
  let db: D1Database;
  let causalityService: CausalityService;
  let accountId: string;
  let decision1Id: string;
  let decision2Id: string;

  beforeAll(async () => {
    db = await setupTestDb();
    causalityService = new CausalityService(db);
    accountId = 'causal-account-' + Date.now();

    await db.prepare('INSERT INTO accounts (id, name, email, tier) VALUES (?, ?, ?, ?)').bind(accountId, 'Test', 'test@example.com', 'free').run();

    decision1Id = 'causal-dec1-' + Date.now();
    decision2Id = 'causal-dec2-' + Date.now();

    for (const id of [decision1Id, decision2Id]) {
      await db
        .prepare('INSERT INTO decisions (id, account_id, decision_type, context, outcome, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, accountId, 'test', JSON.stringify({}), 'outcome', 0.5, 'private', new Date().toISOString(), new Date().toISOString())
        .run();
    }
  });

  it('should add causal edge', async () => {
    const edge = await causalityService.addCausalityEdge(decision1Id, decision2Id, 'decision1 caused decision2', accountId);
    expect(edge).toBeDefined();
    expect(edge.from_decision_id).toBe(decision1Id);
    expect(edge.to_decision_id).toBe(decision2Id);
  });

  it('should detect self-loop cycles', async () => {
    try {
      await causalityService.addCausalityEdge(decision1Id, decision1Id, 'self loop', accountId);
      expect.fail('Should detect self-loop');
    } catch (e) {
      expect((e as Error).message).toContain('Cycle');
    }
  });

  it('should get causality graph', async () => {
    const graph = await causalityService.getCausalityGraph(decision2Id, accountId);
    expect(graph).toBeDefined();
    expect(graph.nodes).toBeDefined();
    expect(graph.edges).toBeDefined();
    expect(graph.depth).toBeGreaterThanOrEqual(0);
  });

  it('should enforce account isolation', async () => {
    const otherAccount = 'other-' + Date.now();
    await db.prepare('INSERT INTO accounts (id, name, email, tier) VALUES (?, ?, ?, ?)').bind(otherAccount, 'Other', 'other@example.com', 'free').run();

    try {
      await causalityService.addCausalityEdge(decision1Id, decision2Id, 'test', otherAccount);
      expect.fail('Should enforce account isolation');
    } catch (e) {
      expect((e as Error).message).toContain('unauthorized');
    }
  });

  it('should handle missing decisions', async () => {
    try {
      await causalityService.addCausalityEdge('nonexistent', decision2Id, 'test', accountId);
      expect.fail('Should reject nonexistent decision');
    } catch (e) {
      expect((e as Error).message).toContain('not found');
    }
  });

  it('should detect indirect cycles', async () => {
    const dec3Id = 'causal-dec3-' + Date.now();
    await db
      .prepare('INSERT INTO decisions (id, account_id, decision_type, context, outcome, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(dec3Id, accountId, 'test', JSON.stringify({}), 'outcome', 0.5, 'private', new Date().toISOString(), new Date().toISOString())
      .run();

    const dec1b = 'causal-dec1b-' + Date.now();
    const dec2b = 'causal-dec2b-' + Date.now();
    const dec3b = 'causal-dec3b-' + Date.now();

    for (const id of [dec1b, dec2b, dec3b]) {
      await db
        .prepare('INSERT INTO decisions (id, account_id, decision_type, context, outcome, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, accountId, 'test', JSON.stringify({}), 'outcome', 0.5, 'private', new Date().toISOString(), new Date().toISOString())
        .run();
    }

    await causalityService.addCausalityEdge(dec1b, dec2b, 'causes', accountId);
    await causalityService.addCausalityEdge(dec2b, dec3b, 'causes', accountId);

    try {
      await causalityService.addCausalityEdge(dec3b, dec1b, 'would create cycle', accountId);
      expect.fail('Should detect indirect cycle');
    } catch (e) {
      expect((e as Error).message.toLowerCase()).toContain('cycle');
    }
  });
});
