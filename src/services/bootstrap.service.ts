/**
 * Tier 12: Bootstrap Templates Service
 * Pre-made decision trees for common scenarios
 */

import { uuid, now } from '../utils/crypto';

export interface BootstrapTemplate {
  id: string;
  decision_type: string;
  category: string;
  title?: string;
  description?: string;
  template_decisions: unknown[];
  success_rate: number;
  usage_count: number;
}

export class BootstrapService {
  constructor(private db: D1Database) {}

  async getTemplates(decisionType: string): Promise<BootstrapTemplate[]> {
    const rows = await this.db
      .prepare('SELECT * FROM bootstrap_templates WHERE decision_type = ? ORDER BY usage_count DESC')
      .bind(decisionType)
      .all<Record<string, unknown>>();

    return (rows.results || []).map(r => this.rowToTemplate(r));
  }

  async getTemplate(templateId: string): Promise<BootstrapTemplate | null> {
    const row = await this.db.prepare('SELECT * FROM bootstrap_templates WHERE id = ? LIMIT 1').bind(templateId).first<Record<string, unknown>>();
    if (!row) return null;
    return this.rowToTemplate(row);
  }

  async applyTemplate(templateId: string, accountId: string, customParams?: Record<string, unknown>): Promise<{ instance_id: string; decisions_created: number }> {
    const template = await this.getTemplate(templateId);
    if (!template) throw new Error('Template not found');

    const instanceId = uuid();
    const ts = now();
    const templateDecisions = template.template_decisions as Array<Record<string, unknown>>;
    const createdDecisions: string[] = [];

    // Create decisions from template
    for (const tmplDecision of templateDecisions) {
      const decId = uuid();
      const context = { ...tmplDecision, ...customParams };

      await this.db
        .prepare(
          `INSERT INTO decisions (id, account_id, decision_type, context, outcome, confidence, visibility, context_compressed, context_raw, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          decId,
          accountId,
          template.decision_type,
          JSON.stringify(context),
          String(tmplDecision.outcome || 'applied_from_template'),
          Number(tmplDecision.confidence || 0.7),
          'private',
          0,
          JSON.stringify(context),
          ts,
          ts
        )
        .run();

      createdDecisions.push(decId);
    }

    // Create instance record
    await this.db
      .prepare(
        `INSERT INTO bootstrap_instances (id, template_id, account_id, title, description, instantiated_decisions, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        instanceId,
        templateId,
        accountId,
        String(customParams?.title || template.category),
        String(customParams?.description || ''),
        JSON.stringify(createdDecisions),
        ts
      )
      .run();

    // Update usage count
    await this.db
      .prepare('UPDATE bootstrap_templates SET usage_count = usage_count + 1 WHERE id = ?')
      .bind(templateId)
      .run();

    return { instance_id: instanceId, decisions_created: createdDecisions.length };
  }

  async listCategories(): Promise<string[]> {
    const rows = await this.db
      .prepare('SELECT DISTINCT category FROM bootstrap_templates WHERE category IS NOT NULL ORDER BY category')
      .all<{ category: string }>();

    return (rows.results || []).map(r => r.category);
  }

  async createTemplate(decisionType: string, templateDecisions: unknown[], successRate = 0.5, category = 'general'): Promise<BootstrapTemplate> {
    const id = uuid();
    const ts = now();

    await this.db
      .prepare(
        `INSERT INTO bootstrap_templates (id, decision_type, category, template_decisions, success_rate, usage_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, decisionType, category, JSON.stringify(templateDecisions), successRate, 0, ts)
      .run();

    return {
      id,
      decision_type: decisionType,
      category,
      template_decisions: templateDecisions,
      success_rate: successRate,
      usage_count: 0,
    };
  }

  private rowToTemplate(row: Record<string, unknown>): BootstrapTemplate {
    return {
      id: String(row.id),
      decision_type: String(row.decision_type),
      category: String(row.category),
      title: row.title ? String(row.title) : undefined,
      description: row.description ? String(row.description) : undefined,
      template_decisions: JSON.parse(String(row.template_decisions)),
      success_rate: Number(row.success_rate),
      usage_count: Number(row.usage_count),
    };
  }
}
