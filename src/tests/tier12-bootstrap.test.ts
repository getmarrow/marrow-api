import { describe, it, expect, beforeAll } from 'vitest';
import { setupTestDb } from './helpers';
import { BootstrapService } from '../services/bootstrap.service';

describe('Tier 12: Bootstrap Templates', () => {
  let db: D1Database;
  let service: BootstrapService;
  let accountId: string;
  let templateId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    service = new BootstrapService(db);
    accountId = 'bootstrap-account-' + Date.now();
    templateId = 'bootstrap-template-' + Date.now();

    await db.prepare('INSERT INTO accounts (id, name, email, tier) VALUES (?, ?, ?, ?)').bind(accountId, 'Test', 'test@example.com', 'free').run();
    await db
      .prepare('INSERT INTO bootstrap_templates (id, decision_type, category, template_decisions, success_rate) VALUES (?, ?, ?, ?, ?)')
      .bind(templateId, 'test-type', 'general', JSON.stringify([{ outcome: 'test' }]), 0.7)
      .run();
  });

  it('should get templates', async () => {
    const templates = await service.getTemplates('test-type');
    expect(Array.isArray(templates)).toBe(true);
  });

  it('should apply template', async () => {
    const result = await service.applyTemplate(templateId, accountId);
    expect(result).toBeDefined();
    expect(result.instance_id).toBeDefined();
    expect(result.decisions_created).toBeGreaterThan(0);
  });

  it('should list categories', async () => {
    const categories = await service.listCategories();
    expect(Array.isArray(categories)).toBe(true);
  });

  it('should create template', async () => {
    const template = await service.createTemplate('new-type', [{ outcome: 'new' }], 0.9, 'custom');
    expect(template).toBeDefined();
    expect(template.decision_type).toBe('new-type');
  });

  it('should reject nonexistent template', async () => {
    try {
      await service.applyTemplate('nonexistent', accountId);
      expect.fail('Should reject nonexistent template');
    } catch (e) {
      expect((e as Error).message).toContain('not found');
    }
  });
});
