import { describe, it, expect, beforeAll } from 'vitest';
import { setupTestDb } from './helpers';
import { TransferService } from '../services/transfer.service';

describe('Tier 9: Transfer Learning', () => {
  let db: D1Database;
  let service: TransferService;
  let accountId: string;
  let lessonId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    service = new TransferService(db);
    accountId = 'transfer-account-' + Date.now();
    lessonId = 'transfer-lesson-' + Date.now();

    await db.prepare('INSERT INTO accounts (id, name, email, tier) VALUES (?, ?, ?, ?)').bind(accountId, 'Test', 'test@example.com', 'free').run();
    await db
      .prepare('INSERT INTO lessons (id, account_id, decision_type, pattern, success_rate) VALUES (?, ?, ?, ?, ?)')
      .bind(lessonId, accountId, 'domain-a', 'test pattern', 0.8)
      .run();
  });

  it('should get transferable lessons', async () => {
    const lessons = await service.getTransferableLessons('domain-a', 'domain-b', 10);
    expect(Array.isArray(lessons)).toBe(true);
  });

  it('should transfer lesson', async () => {
    const result = await service.transferLesson(lessonId, accountId, 'domain-a', 'domain-b');
    expect(result).toBeDefined();
    expect(result.transfer_id).toBeDefined();
    expect(typeof result.effectiveness).toBe('number');
  });

  it('should calculate transfer metrics', async () => {
    await service.transferLesson(lessonId, accountId, 'domain-x', 'domain-y');
    const metrics = await service.calculateTransferMetrics(accountId, 'domain-x', 'domain-y');
    expect(metrics).toBeDefined();
    expect(metrics.transfer_count).toBeGreaterThan(0);
  });

  it('should reject nonexistent lesson', async () => {
    try {
      await service.transferLesson('nonexistent', accountId, 'a', 'b');
      expect.fail('Should reject nonexistent lesson');
    } catch (e) {
      expect((e as Error).message).toContain('not found');
    }
  });

  it('should enforce account isolation', async () => {
    const otherAccount = 'other-' + Date.now();
    await db.prepare('INSERT INTO accounts (id, name, email, tier) VALUES (?, ?, ?, ?)').bind(otherAccount, 'Other', 'other@example.com', 'free').run();

    try {
      await service.transferLesson(lessonId, otherAccount, 'a', 'b');
      expect.fail('Should enforce account isolation');
    } catch (e) {
      expect((e as Error).message).toContain('unauthorized');
    }
  });
});
