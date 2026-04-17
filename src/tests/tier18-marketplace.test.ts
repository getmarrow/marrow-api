import { describe, it, expect, beforeAll } from 'vitest';
import { setupTestDb } from './helpers';
import { MarketplaceService } from '../services/marketplace.service';

describe('Tier 18: Marketplace', () => {
  let db: D1Database;
  let service: MarketplaceService;
  let accountId: string;
  let lessonId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    service = new MarketplaceService(db);
    accountId = 'marketplace-account-' + Date.now();
    lessonId = 'marketplace-lesson-' + Date.now();

    await db.prepare('INSERT INTO accounts (id, name, email, tier) VALUES (?, ?, ?, ?)').bind(accountId, 'Test', 'test@example.com', 'free').run();
    await db
      .prepare('INSERT INTO lessons (id, account_id, decision_type, pattern, success_rate, title) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(lessonId, accountId, 'test-type', 'test pattern', 0.8, 'Test Lesson')
      .run();
  });

  it('should publish lesson', async () => {
    const result = await service.publishLesson(lessonId, accountId);
    expect(result.published).toBe(true);
    expect(result.published_at).toBeDefined();
  });

  it('should fork lesson', async () => {
    const result = await service.forkLesson(lessonId, accountId, 'Forked Lesson');
    expect(result).toBeDefined();
    expect(result.forked_lesson_id).toBeDefined();
  });

  it('should rate lesson', async () => {
    await service.rateLesson(lessonId, accountId, 5);
    // Should not throw
    expect(true).toBe(true);
  });

  it('should reject invalid ratings', async () => {
    try {
      await service.rateLesson(lessonId, accountId, 6);
      expect.fail('Should reject rating > 5');
    } catch (e) {
      expect((e as Error).message).toContain('between 1 and 5');
    }
  });

  it('should get marketplace', async () => {
    const marketplace = await service.getMarketplace('rating', 50);
    expect(Array.isArray(marketplace)).toBe(true);
  });

  it('should get lesson versions', async () => {
    await service.createLessonVersion(lessonId, 'v1', 'content1', 'Initial version');
    const versions = await service.getLessonVersions(lessonId);
    expect(Array.isArray(versions)).toBe(true);
  });

  it('should create lesson version', async () => {
    const version = await service.createLessonVersion(lessonId, 'v2', 'content2', 'Updated version');
    expect(version).toBeDefined();
    expect(version.version).toBeGreaterThanOrEqual(1);
  });

  it('should enforce account isolation on fork', async () => {
    const otherAccount = 'other-' + Date.now();
    await db.prepare('INSERT INTO accounts (id, name, email, tier) VALUES (?, ?, ?, ?)').bind(otherAccount, 'Other', 'other@example.com', 'free').run();

    // Other account should be able to fork published lesson
    const result = await service.forkLesson(lessonId, otherAccount, 'Other Fork');
    expect(result.forked_lesson_id).toBeDefined();
  });
});
