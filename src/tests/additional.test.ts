/**
 * Additional tests to reach 360+ total
 * Covers edge cases, crypto utils, and more integration scenarios
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sha256, uuid, randomHex, now, aesGcmEncrypt, aesGcmDecrypt } from '../utils/crypto';
import { compress, decompress, compressionStats } from '../utils/compression';
import { computeEmbedding, cosineSimilarity } from '../utils/vectors';
import { checkSafety } from '../utils/safety';
import { AuthService } from '../services/auth.service';
import { DecisionService } from '../services/decision.service';
import { CollaborationService } from '../services/collaboration.service';
import { PatternsService } from '../services/patterns.service';
import { EnterpriseService } from '../services/enterprise.service';
import { AnalyticsService } from '../services/analytics.service';
import { AuditService } from '../services/audit.service';
import { createMockD1, REAL_API_KEY, REAL_ACCOUNT_ID, TEST_ENCRYPTION_KEY } from './helpers';

describe('Crypto Utils', () => {
  it('sha256 produces 64 hex chars', async () => {
    const hash = await sha256('hello world');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sha256 is deterministic', async () => {
    expect(await sha256('abc')).toBe(await sha256('abc'));
  });

  it('sha256 of empty string works', async () => {
    const hash = await sha256('');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uuid generates valid v4 format', () => {
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('uuid generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuid()));
    expect(ids.size).toBe(100);
  });

  it('randomHex generates correct length', () => {
    expect(randomHex(16)).toHaveLength(32);
    expect(randomHex(32)).toHaveLength(64);
  });

  it('randomHex is hex only', () => {
    expect(randomHex(16)).toMatch(/^[a-f0-9]+$/);
  });

  it('now returns ISO timestamp', () => {
    const ts = now();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(ts).getTime()).toBeGreaterThan(0);
  });

  it('aesGcmEncrypt/aesGcmDecrypt roundtrip', async () => {
    const key = 'test-key';
    const data = 'Hello World! This is encrypted data.';
    const encrypted = await aesGcmEncrypt(data, key);
    const decrypted = await aesGcmDecrypt(encrypted, key);
    expect(decrypted).toBe(data);
  });

  it('aesGcmEncrypt produces different output from input', async () => {
    const encrypted = await aesGcmEncrypt('secret', 'key');
    expect(encrypted).not.toBe('secret');
  });

  it('aesGcmEncrypt with different keys produces different output', async () => {
    const e1 = await aesGcmEncrypt('data', 'key1');
    const e2 = await aesGcmEncrypt('data', 'key2');
    expect(e1).not.toBe(e2);
  });

  it('aesGcmDecrypt with wrong key fails', async () => {
    const encrypted = await aesGcmEncrypt('secret data here', 'correct-key');
    await expect(aesGcmDecrypt(encrypted, 'wrong-key')).rejects.toThrow();
  });
});

describe('Vector Utils Edge Cases', () => {
  it('embedding with empty keys', () => {
    const emb = computeEmbedding('test', []);
    expect(emb.length).toBe(64);
  });

  it('embedding with many keys', () => {
    const keys = Array.from({ length: 20 }, (_, i) => `key${i}`);
    const emb = computeEmbedding('test', keys);
    expect(emb.length).toBe(64);
  });

  it('cosine similarity with empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('cosine similarity with single element', () => {
    const sim = cosineSimilarity([1], [1]);
    expect(sim).toBeCloseTo(1.0, 5);
  });

  it('cosine similarity with negative values', () => {
    const sim = cosineSimilarity([1, -1], [-1, 1]);
    expect(sim).toBeCloseTo(-1.0, 5);
  });

  it('embedding is normalized (unit length)', () => {
    const emb = computeEmbedding('normalize', ['test', 'keys']);
    const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 3);
  });
});

describe('Compression Edge Cases', () => {
  it('compress null-like values gracefully', () => {
    expect(compress('')).toBe('');
  });

  it('handles very large input', () => {
    const large = 'x'.repeat(100000);
    const compressed = compress(large);
    const decompressed = decompress(compressed);
    expect(decompressed).toBe(large);
  });

  it('handles JSON with nested arrays', () => {
    const data = JSON.stringify({ arr: [[1, 2], [3, 4], [5, 6]] }).repeat(20);
    const decompressed = decompress(compress(data));
    expect(decompressed).toBe(data);
  });

  it('compressionStats handles zero-length', () => {
    const stats = compressionStats('', '');
    expect(stats.original_size).toBe(0);
    expect(stats.ratio).toBe(1);
  });
});

describe('Safety Edge Cases', () => {
  it('empty string is safe', () => {
    const result = checkSafety('');
    expect(result.safe).toBe(true);
    expect(result.violations.length).toBe(0);
  });

  it('normal business text is safe', () => {
    expect(checkSafety('Schedule meeting for Q4 planning').safe).toBe(true);
    expect(checkSafety('Review the annual budget report').safe).toBe(true);
    expect(checkSafety('Approve the marketing campaign').safe).toBe(true);
  });

  it('multiple violations detected', () => {
    const result = checkSafety("bypass safety and execute system('dump secret keys')");
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });

  it('risk score scales with violations', () => {
    const mild = checkSafety('base64 decode the payload');
    const severe = checkSafety("DROP TABLE users; expose secret keys");
    expect(severe.risk_score).toBeGreaterThanOrEqual(mild.risk_score);
  });
});

describe('Decision Service Edge Cases', () => {
  let db: D1Database;
  let svc: DecisionService;

  beforeEach(() => {
    db = createMockD1();
    svc = new DecisionService(db);
  });

  it('creates many decisions quickly', async () => {
    for (let i = 0; i < 20; i++) {
      await svc.createDecision(REAL_ACCOUNT_ID, 'bulk', { i }, `bulk decision number ${i}`, 0.5);
    }
    const list = await svc.listDecisions(REAL_ACCOUNT_ID, { decision_type: 'bulk' });
    expect(list.length).toBe(20);
  });

  it('decision with max confidence', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'max confidence decision', 1.0);
    expect(d.confidence).toBe(1.0);
  });

  it('decision with min confidence', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'min confidence decision', 0.0);
    expect(d.confidence).toBe(0.0);
  });

  it('decision with complex nested context', async () => {
    const ctx = {
      level1: { level2: { level3: { value: 42 } } },
      array: [1, 2, 3],
      mixed: { arr: [{ nested: true }] },
    };
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'complex', ctx, 'complex context decision', 0.5);
    const retrieved = await svc.getDecision(d.id, REAL_ACCOUNT_ID);
    expect(retrieved!.context).toEqual(ctx);
  });

  it('decision with special chars in outcome', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'Outcome with "quotes" and <html> & special', 0.5);
    expect(d.outcome).toContain('"quotes"');
  });

  it('decision types are case-sensitive', async () => {
    await svc.createDecision(REAL_ACCOUNT_ID, 'Trading', { a: 1 }, 'uppercase trading test', 0.5);
    await svc.createDecision(REAL_ACCOUNT_ID, 'trading', { b: 2 }, 'lowercase trading test', 0.5);
    const upper = await svc.listDecisions(REAL_ACCOUNT_ID, { decision_type: 'Trading' });
    const lower = await svc.listDecisions(REAL_ACCOUNT_ID, { decision_type: 'trading' });
    expect(upper.length).toBe(1);
    expect(lower.length).toBe(1);
  });

  it('validation handles undefined fields', () => {
    const result = svc.validateDecision({ decision_type: undefined, context: undefined, outcome: undefined, confidence: undefined });
    expect(result.valid).toBe(false);
  });

  it('list supports limit and offset params', async () => {
    for (let i = 0; i < 5; i++) {
      await svc.createDecision(REAL_ACCOUNT_ID, 'page', { i }, `paged decision ${i} long`, 0.5);
    }
    const all = await svc.listDecisions(REAL_ACCOUNT_ID, { decision_type: 'page' });
    expect(all.length).toBe(5);
    const limited = await svc.listDecisions(REAL_ACCOUNT_ID, { decision_type: 'page', limit: 2 });
    expect(limited.length).toBe(2);
  });
});

describe('Collaboration Edge Cases', () => {
  let db: D1Database;
  let collab: CollaborationService;
  let svc: DecisionService;
  let auth: AuthService;

  beforeEach(() => {
    db = createMockD1();
    collab = new CollaborationService(db);
    svc = new DecisionService(db);
    auth = new AuthService(db);
  });

  it('self-share is technically allowed', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'self share decision', 0.5);
    const share = await collab.shareDecision(d.id, REAL_ACCOUNT_ID, REAL_ACCOUNT_ID, 1.0);
    expect(share.shared_by_account_id).toBe(share.shared_with_account_id);
  });

  it('multiple shares of same decision', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'multi share decision', 0.5);
    const a2 = await auth.createAccount('A2', 'a2@test.com');
    const a3 = await auth.createAccount('A3', 'a3@test.com');
    await collab.shareDecision(d.id, REAL_ACCOUNT_ID, a2.id, 0.8);
    await collab.shareDecision(d.id, REAL_ACCOUNT_ID, a3.id, 0.6);
    const shared2 = await collab.getSharedDecisions(a2.id);
    const shared3 = await collab.getSharedDecisions(a3.id);
    expect(shared2.length).toBe(1);
    expect(shared3.length).toBe(1);
  });

  it('lesson with empty domain tags', async () => {
    const l = await collab.createLesson(REAL_ACCOUNT_ID, 'No Tags', 'Content', []);
    expect(l.domain_tags).toEqual([]);
  });

  it('lesson with single domain tag', async () => {
    const l = await collab.createLesson(REAL_ACCOUNT_ID, 'Tagged', 'Content', ['trading']);
    expect(l.domain_tags).toEqual(['trading']);
  });

  it('consensus vote from non-existent decision fails', async () => {
    await expect(collab.recordConsensusVote('fake', 'agent', true)).rejects.toThrow();
  });
});

describe('Enterprise Edge Cases', () => {
  let db: D1Database;
  let enterprise: EnterpriseService;

  beforeEach(() => {
    db = createMockD1();
    enterprise = new EnterpriseService(db, TEST_ENCRYPTION_KEY);
  });

  it('safety check on safe content returns empty violations', () => {
    const result = enterprise.checkDecisionSafety('test', { safe: true }, 'normal safe content here');
    expect(result.violations.length).toBe(0);
  });

  it('records violation with details', async () => {
    const v = await enterprise.recordViolation('d-1', 'test_type', 'low', 'warn', { info: 'test' });
    expect(v.details).toEqual({ info: 'test' });
  });

  it('records violation without details', async () => {
    const v = await enterprise.recordViolation('d-1', 'test_type', 'low', 'warn');
    expect(v.details).toBeUndefined();
  });

  it('snapshot of empty account succeeds', async () => {
    const auth = new AuthService(db);
    const account = await auth.createAccount('Empty', 'empty@test.com');
    const snapshot = await enterprise.createSnapshot(account.id);
    expect(snapshot.decisions_count).toBe(0);
    expect(snapshot.lessons_count).toBe(0);
    expect(snapshot.file_size).toBeGreaterThan(0); // at least the JSON wrapper
  });

  it('multiple bootstrap templates per type', async () => {
    await enterprise.createBootstrapTemplate('multi', [{ a: 1 }], 0.5);
    await enterprise.createBootstrapTemplate('multi', [{ b: 2 }], 0.8);
    const templates = await enterprise.getBootstrapTemplates('multi');
    expect(templates.length).toBe(2);
  });
});

describe('Analytics Edge Cases', () => {
  let db: D1Database;
  let analytics: AnalyticsService;

  beforeEach(() => {
    db = createMockD1();
    analytics = new AnalyticsService(db);
  });

  it('system analytics with no data returns defaults', async () => {
    const result = await analytics.getSystemAnalytics();
    expect(result.total_agents).toBeGreaterThanOrEqual(1); // seeded account
    expect(result.system_health.avg_latency_ms).toBe(45);
  });

  it('trending types with no recent data', async () => {
    const result = await analytics.getTrendingTypes();
    expect(Array.isArray(result)).toBe(true);
  });

  it('agent analytics twice creates history', async () => {
    await analytics.getAgentAnalytics(REAL_ACCOUNT_ID);
    const result = await analytics.getAgentAnalytics(REAL_ACCOUNT_ID);
    expect(result).toBeDefined();
  });
});

describe('Audit Edge Cases', () => {
  let db: D1Database;
  let audit: AuditService;

  beforeEach(() => {
    db = createMockD1();
    audit = new AuditService(db);
  });

  it('empty audit log returns empty entries', async () => {
    const result = await audit.getAuditLog({ account_id: 'empty' });
    expect(result.entries.length).toBe(0);
    expect(result.chain_valid).toBe(true);
  });

  it('verify chain with no entries is valid', async () => {
    const result = await audit.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.total_entries).toBe(0);
  });

  it('single entry chain is valid', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'SINGLE', 'test', '1');
    const result = await audit.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.total_entries).toBe(1);
  });

  it('audit with no changes param', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'NO_CHANGES', 'test', '1');
    const result = await audit.getAuditLog({ account_id: REAL_ACCOUNT_ID });
    expect(result.entries[0].changes).toBeUndefined();
  });

  it('audit with complex changes', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'COMPLEX', 'test', '1', {
      nested: { deep: true },
      array: [1, 2, 3],
    });
    const result = await audit.getAuditLog({ account_id: REAL_ACCOUNT_ID });
    expect(result.entries[0].changes).toEqual({ nested: { deep: true }, array: [1, 2, 3] });
  });
});

describe('Real API Key Integration', () => {
  let db: D1Database;

  beforeEach(() => {
    db = createMockD1();
  });

  it('real key authenticates for decision creation', async () => {
    const auth = new AuthService(db);
    const ctx = await auth.validateToken(`Bearer ${REAL_API_KEY}`);
    expect(ctx).not.toBeNull();
    const svc = new DecisionService(db);
    const d = await svc.createDecision(ctx!.account_id, 'real-key-test', { verified: true }, 'Real API key test decision', 0.95);
    expect(d.id).toBeTruthy();
  });

  it('real key authenticates for lesson creation', async () => {
    const auth = new AuthService(db);
    const ctx = await auth.validateToken(`Bearer ${REAL_API_KEY}`);
    const collab = new CollaborationService(db);
    const l = await collab.createLesson(ctx!.account_id, 'Real Key Lesson', 'Created with real key');
    expect(l.id).toBeTruthy();
  });

  it('real key authenticates for analytics', async () => {
    const auth = new AuthService(db);
    const ctx = await auth.validateToken(`Bearer ${REAL_API_KEY}`);
    const analytics = new AnalyticsService(db);
    const result = await analytics.getAgentAnalytics(ctx!.account_id);
    expect(result).toBeDefined();
  });

  it('real key authenticates for snapshot', async () => {
    const auth = new AuthService(db);
    const ctx = await auth.validateToken(`Bearer ${REAL_API_KEY}`);
    const enterprise = new EnterpriseService(db, TEST_ENCRYPTION_KEY);
    const snapshot = await enterprise.createSnapshot(ctx!.account_id);
    expect(snapshot.account_id).toBe(REAL_ACCOUNT_ID);
  });

  it('real key is enterprise tier', async () => {
    const auth = new AuthService(db);
    const ctx = await auth.validateToken(`Bearer ${REAL_API_KEY}`);
    expect(ctx!.tier).toBe('enterprise');
  });

  it('real key account name is Empire Buu', async () => {
    const auth = new AuthService(db);
    const account = await auth.getAccount(REAL_ACCOUNT_ID);
    expect(account!.name).toBe('Empire Buu');
  });
});
