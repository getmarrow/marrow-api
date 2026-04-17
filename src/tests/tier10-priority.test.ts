import { describe, it, expect, beforeAll } from 'vitest';
import { setupTestDb } from './helpers';
import { PriorityService } from '../services/priority.service';

describe('Tier 10: Priority Queue', () => {
  let db: D1Database;
  let service: PriorityService;
  let accountId: string;
  let decisionId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    service = new PriorityService(db);
    accountId = 'priority-account-' + Date.now();
    decisionId = 'priority-dec-' + Date.now();

    await db.prepare('INSERT INTO accounts (id, name, email, tier) VALUES (?, ?, ?, ?)').bind(accountId, 'Test', 'test@example.com', 'free').run();
    await db
      .prepare('INSERT INTO decisions (id, account_id, decision_type, context, outcome, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(decisionId, accountId, 'test', JSON.stringify({}), 'outcome', 0.5, 'private', new Date().toISOString(), new Date().toISOString())
      .run();
  });

  it('should calculate priority', async () => {
    const priority = await service.calculatePriority(decisionId, accountId, 'high', 0.8);
    expect(priority).toBeDefined();
    expect(priority.score).toBeGreaterThan(0);
  });

  it('should get queue by priority', async () => {
    const queue = await service.getQueueByPriority(accountId, 10);
    expect(Array.isArray(queue)).toBe(true);
  });

  it('should get queue status', async () => {
    const status = await service.getQueueStatus(accountId);
    expect(status).toBeDefined();
    expect(typeof status.avg_score).toBe('number');
  });

  it('should recalculate queue', async () => {
    await service.recalculateQueue(accountId);
    const status = await service.getQueueStatus(accountId);
    expect(status.total).toBeGreaterThanOrEqual(0);
  });

  it('should update priority', async () => {
    const priority1 = await service.calculatePriority(decisionId, accountId, 'low', 0.3);
    const priority2 = await service.calculatePriority(decisionId, accountId, 'critical', 0.9);
    expect(priority2.score).toBeGreaterThan(priority1.score);
  });
});
