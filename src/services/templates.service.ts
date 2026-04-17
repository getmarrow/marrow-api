/**
 * Templates Service — workflow template marketplace (V5 Phase 1)
 */
import { uuid, now } from '../utils/crypto';

export interface WorkflowTemplate {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  industry: string | null;
  category: string | null;
  author: string;
  steps: string; // JSON array
  install_count: number;
  avg_success_rate: number | null;
  tags: string; // JSON array
  created_at: string;
  updated_at: string;
}

interface TemplateFilters {
  industry?: string;
  category?: string;
  limit?: number;
  search?: string;
}

interface TemplateInput {
  name: string;
  description?: string;
  industry?: string;
  category?: string;
  steps: unknown[];
  tags?: string[];
}

export class TemplatesService {
  constructor(private db: D1Database) {}

  /**
   * List templates with optional filters.
   */
  async listTemplates(filters: TemplateFilters = {}): Promise<WorkflowTemplate[]> {
    const limit = Math.min(Math.max(filters.limit || 20, 1), 100);
    const conditions: string[] = [];
    const binds: unknown[] = [];

    if (filters.industry) {
      conditions.push('industry = ?');
      binds.push(filters.industry.trim().slice(0, 50));
    }
    if (filters.category) {
      conditions.push('category = ?');
      binds.push(filters.category.trim().slice(0, 50));
    }
    if (filters.search) {
      conditions.push('(name LIKE ? OR description LIKE ? OR tags LIKE ?)');
      const term = `%${filters.search.trim().slice(0, 100)}%`;
      binds.push(term, term, term);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    binds.push(limit);

    const res = await this.db
      .prepare(
        `SELECT * FROM workflow_templates ${where}
         ORDER BY install_count DESC, created_at DESC
         LIMIT ?`
      )
      .bind(...binds)
      .all<WorkflowTemplate>();

    return res.results || [];
  }

  /**
   * Get a single template by slug.
   */
  async getTemplate(slug: string): Promise<WorkflowTemplate | null> {
    return this.db
      .prepare('SELECT * FROM workflow_templates WHERE slug = ?')
      .bind(slug)
      .first<WorkflowTemplate>();
  }

  /**
   * Install a template — creates a workflow in the existing workflows table.
   * Returns the new workflow_id.
   */
  async installTemplate(slug: string, accountId: string): Promise<{ workflow_id: string }> {
    const template = await this.getTemplate(slug);
    if (!template) throw new Error(`Template '${slug}' not found`);

    const workflowId = uuid();
    const ts = now();

    // Parse template steps
    let steps: { step: number; name: string; description: string; agent_role?: string }[];
    try {
      steps = JSON.parse(template.steps);
    } catch {
      throw new Error('Invalid template step format');
    }

    // Create workflow in existing workflows table
    await this.db
      .prepare(
        `INSERT INTO workflows (id, name, description, status, tags, created_at, updated_at, account_id)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .bind(
        workflowId,
        template.name,
        template.description || '',
        template.tags || '[]',
        ts,
        ts,
        accountId
      )
      .run();

    // Create workflow steps
    for (const step of steps) {
      const stepId = uuid();
      await this.db
        .prepare(
          `INSERT INTO workflow_steps (id, workflow_id, step_order, step_name, agent_role, description)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(stepId, workflowId, step.step, step.name, step.agent_role || null, step.description || '')
        .run();
    }

    // Increment install count
    await this.db
      .prepare('UPDATE workflow_templates SET install_count = install_count + 1 WHERE slug = ?')
      .bind(slug)
      .run();

    return { workflow_id: workflowId };
  }

  /**
   * Publish a custom template (admin only or team+ plan).
   */
  async publishTemplate(input: TemplateInput, accountId: string): Promise<WorkflowTemplate> {
    const id = uuid();
    const ts = now();
    const name = (input.name || '').trim().slice(0, 100);
    if (!name) throw new Error('Template name is required');
    if (!input.steps || !Array.isArray(input.steps) || input.steps.length === 0) {
      throw new Error('Template must have at least one step');
    }

    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);

    const description = input.description?.trim().slice(0, 500) || null;
    const industry = input.industry?.trim().slice(0, 50) || null;
    const category = input.category?.trim().slice(0, 50) || null;
    const stepsJson = JSON.stringify(input.steps);
    const tagsJson = JSON.stringify(input.tags || []);

    // L2 fix: Catch slug collision and provide clear error
    try {
      await this.db
        .prepare(
          `INSERT INTO workflow_templates (id, name, slug, description, industry, category, author, steps, tags, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, name, slug, description, industry, category, accountId, stepsJson, tagsJson, ts, ts)
        .run();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('UNIQUE')) throw new Error(`Template with name "${name}" already exists. Choose a different name.`);
      throw e;
    }

    return {
      id,
      name,
      slug,
      description,
      industry,
      category,
      author: accountId,
      steps: stepsJson,
      install_count: 0,
      avg_success_rate: null,
      tags: tagsJson,
      created_at: ts,
      updated_at: ts,
    };
  }
}
