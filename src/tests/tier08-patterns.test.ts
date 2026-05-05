import { describe, it, expect, beforeAll } from 'vitest';
import { setupTestDb } from './helpers';
import { PatternsService } from '../services/patterns.service';

describe('Tier 8: Pattern Recognition', () => {
  let db: D1Database;
  let service: PatternsService;
  let accountId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    service = new PatternsService(db);
    accountId = 'pattern-account-' + Date.now();

    await db.prepare('INSERT INTO accounts (id, name, email, tier) VALUES (?, ?, ?, ?)').bind(accountId, 'Test', 'test@example.com', 'free').run();
    await db
      .prepare('INSERT INTO patterns (id, decision_type, pattern_signature, frequency, confidence) VALUES (?, ?, ?, ?, ?)')
      .bind('pattern1', 'type1', 'key1|key2|key3', 5, 0.8)
      .run();
  });

  it('should recognize patterns', async () => {
    const patterns = await service.recognizePatterns(accountId, 'type1');
    expect(Array.isArray(patterns)).toBe(true);
  });

  it('should validate pattern', async () => {
    const decId = 'pattern-dec-' + Date.now();
    await db
      .prepare('INSERT INTO decisions (id, account_id, decision_type, context, outcome, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(decId, accountId, 'type1', JSON.stringify({ key1: 'v1', key2: 'v2', key3: 'v3' }), 'outcome', 0.5, 'private', new Date().toISOString(), new Date().toISOString())
      .run();

    const result = await service.validatePattern('pattern1', decId, accountId);
    expect(result).toBeDefined();
    expect(typeof result.confidence).toBe('number');
  });

  it('should get pattern stats', async () => {
    const stats = await service.getPatternStats('pattern1', accountId);
    expect(stats).toBeDefined();
    expect(typeof stats.accuracy).toBe('number');
  });

  it('should discover sequential patterns', async () => {
    const dec1 = 'seq-' + Date.now() + '-1';
    const dec2 = 'seq-' + Date.now() + '-2';
    const dec3 = 'seq-' + Date.now() + '-3';

    for (const [id, type] of [[dec1, 'type-a'], [dec2, 'type-b'], [dec3, 'type-a']]) {
      await db
        .prepare('INSERT INTO decisions (id, account_id, decision_type, context, outcome, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, accountId, type, JSON.stringify({}), 'outcome', 0.5, 'private', new Date().toISOString(), new Date().toISOString())
        .run();
    }

    const sequential = await service.discoverSequentialPatterns(accountId, 2);
    expect(Array.isArray(sequential)).toBe(true);
  });

  it('should calculate similarity', async () => {
    const ctx1 = { a: 1, b: 2, c: 3 };
    const ctx2 = { a: 1, b: 2, d: 4 };
    const similarity = await service.calculateSimilarity(ctx1, ctx2);
    expect(typeof similarity).toBe('number');
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThanOrEqual(1);
  });
});
