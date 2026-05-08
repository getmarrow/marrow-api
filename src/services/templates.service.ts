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
  quality_score?: number;
}

export interface WorkflowTemplateSuggestion {
  slug: string;
  name: string;
  avg_success_rate: number | null;
  install_count: number;
  quality_score: number;
  author: string;
}

export interface TemplateDetectionInput {
  action: string;
  type?: string;
  surfaces?: string[];
  risk_level?: string;
  context?: Record<string, unknown>;
  limit?: number;
}

export interface TemplateDetectionMatch {
  source: 'workflow_template' | 'learned_template';
  slug?: string;
  template_id?: string;
  name: string;
  confidence: number;
  reason: string;
  avg_success_rate?: number | null;
  install_count?: number;
  quality_score?: number;
}

export interface TemplateDetectionResult {
  matched: boolean;
  recommended_template: TemplateDetectionMatch | null;
  alternatives: TemplateDetectionMatch[];
  agent_instruction: string;
  requires_owner_approval: boolean;
  approval_reason: string | null;
  detected_type: string | null;
  detected_surfaces: string[];
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

  computeQualityScore(installCount: number, avgSuccessRate: number | null): number {
    if (!installCount || !avgSuccessRate) return 0;
    return Math.min(1, installCount * avgSuccessRate * 0.1);
  }

  private withQualityScore(template: WorkflowTemplate): WorkflowTemplate {
    return {
      ...template,
      quality_score: this.computeQualityScore(Number(template.install_count || 0), template.avg_success_rate ?? null),
    };
  }

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

    return (res.results || []).map((template) => this.withQualityScore(template));
  }

  /**
   * Get a single template by slug.
   */
  async getTemplate(slug: string): Promise<WorkflowTemplate | null> {
    const template = await this.db
      .prepare('SELECT * FROM workflow_templates WHERE slug = ?')
      .bind(slug)
      .first<WorkflowTemplate>();

    return template ? this.withQualityScore(template) : null;
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

  async getSuggestedTemplates(decisionType: string, limit = 3): Promise<WorkflowTemplateSuggestion[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM workflow_templates
         WHERE category = ? OR tags LIKE ? OR slug LIKE ?
         ORDER BY install_count DESC, created_at DESC
         LIMIT ?`
      )
      .bind(decisionType, `%${decisionType}%`, `%${decisionType}%`, Math.max(limit * 3, limit))
      .all<WorkflowTemplate>();

    return (rows.results || [])
      .map((template) => this.withQualityScore(template))
      .sort((a, b) => {
        const qualityDelta = Number(b.quality_score || 0) - Number(a.quality_score || 0);
        if (qualityDelta !== 0) return qualityDelta;
        const successDelta = Number(b.avg_success_rate || 0) - Number(a.avg_success_rate || 0);
        if (successDelta !== 0) return successDelta;
        return Number(b.install_count || 0) - Number(a.install_count || 0);
      })
      .slice(0, limit)
      .map((template) => ({
        slug: template.slug,
        name: template.name,
        avg_success_rate: template.avg_success_rate ?? null,
        install_count: Number(template.install_count || 0),
        quality_score: Number(template.quality_score || 0),
        author: template.author,
      }));
  }

  async detectTemplate(input: TemplateDetectionInput): Promise<TemplateDetectionResult> {
    const action = String(input.action || '').trim().slice(0, 500);
    if (!action) throw new Error('action is required');

    const providedType = this.normalizeToken(input.type);
    const inferredType = this.detectType(action);
    const detectedType = inferredType || providedType;
    const surfaces = this.detectSurfaces(action, input.surfaces || [], input.context || {});
    const limit = Math.min(Math.max(input.limit || 3, 1), 10);

    const [workflowTemplates, learnedTemplates] = await Promise.all([
      this.listTemplates({ limit: 100 }),
      this.getLearnedTemplateRows(100),
    ]);

    const workflowMatches = workflowTemplates
      .map((template) => this.scoreWorkflowTemplate(template, action, detectedType, surfaces))
      .filter((match): match is TemplateDetectionMatch => Boolean(match));

    const learnedMatches = learnedTemplates
      .map((template) => this.scoreLearnedTemplate(template, action, detectedType, surfaces))
      .filter((match): match is TemplateDetectionMatch => Boolean(match));

    const matches = [...workflowMatches, ...learnedMatches]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);

    const recommended = matches[0] || null;
    const providedRiskLevel = this.normalizeToken(input.risk_level);
    const inferredRiskLevel = this.inferRiskLevel(action, inferredType || detectedType, surfaces);
    const riskLevel = this.highestRiskLevel(providedRiskLevel, inferredRiskLevel);
    const approvalTypes = Array.from(new Set([providedType, inferredType, detectedType].filter((type): type is string => Boolean(type))));
    const requiresOwnerApproval = this.requiresOwnerApproval(riskLevel, approvalTypes, surfaces);

    return {
      matched: Boolean(recommended && recommended.confidence >= 0.35),
      recommended_template: recommended && recommended.confidence >= 0.35 ? recommended : null,
      alternatives: matches.slice(recommended && recommended.confidence >= 0.35 ? 1 : 0),
      agent_instruction: recommended && recommended.confidence >= 0.35
        ? 'Review the recommended template by stable identifier before continuing.'
        : 'No strong template match found. Continue with normal Marrow decision logging and outcome capture.',
      requires_owner_approval: requiresOwnerApproval,
      approval_reason: requiresOwnerApproval
        ? 'Owner approval is recommended before auto-applying templates for high-risk production, security, billing, publish, migration, or deploy work.'
        : null,
      detected_type: detectedType,
      detected_surfaces: surfaces,
    };
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

  private async getLearnedTemplateRows(limit: number): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db
      .prepare(
        `SELECT template_id, pattern_cluster, steps, success_rate, confidence, usage_count, decision_type, created_at
         FROM learned_templates
         ORDER BY confidence DESC, success_rate DESC, usage_count DESC
         LIMIT ?`
      )
      .bind(limit)
      .all<Record<string, unknown>>();
    return rows.results || [];
  }

  private scoreWorkflowTemplate(
    template: WorkflowTemplate,
    action: string,
    detectedType: string | null,
    surfaces: string[],
  ): TemplateDetectionMatch | null {
    const searchable = this.searchableText([
      template.name,
      template.slug,
      template.description,
      template.industry,
      template.category,
      template.tags,
      template.steps,
    ]);
    const actionTokens = this.extractTokens(action);
    const score = this.scoreText(searchable, actionTokens, detectedType, surfaces)
      + Number(template.quality_score || 0) * 0.15
      + Math.min(Number(template.install_count || 0), 20) * 0.005
      + Number(template.avg_success_rate || 0) * 0.1;

    if (score <= 0) return null;

    return {
      source: 'workflow_template',
      slug: template.slug,
      name: template.name,
      confidence: this.clampScore(score),
      reason: this.buildReason(detectedType, surfaces, template.category, template.tags),
      avg_success_rate: template.avg_success_rate ?? null,
      install_count: Number(template.install_count || 0),
      quality_score: Number(template.quality_score || 0),
    };
  }

  private scoreLearnedTemplate(
    template: Record<string, unknown>,
    action: string,
    detectedType: string | null,
    surfaces: string[],
  ): TemplateDetectionMatch | null {
    const searchable = this.searchableText([
      template.template_id,
      template.pattern_cluster,
      template.steps,
      template.decision_type,
    ]);
    const actionTokens = this.extractTokens(action);
    const score = this.scoreText(searchable, actionTokens, detectedType, surfaces)
      + Number(template.confidence || 0) * 0.2
      + Number(template.success_rate || 0) * 0.2
      + Math.min(Number(template.usage_count || 0), 20) * 0.01;

    if (score <= 0) return null;

    const templateId = String(template.template_id || 'learned-template');
    return {
      source: 'learned_template',
      template_id: templateId,
      name: this.humanizeTemplateName(templateId, String(template.decision_type || detectedType || 'workflow')),
      confidence: this.clampScore(score),
      reason: this.buildReason(detectedType, surfaces, String(template.decision_type || ''), ''),
      avg_success_rate: Number(template.success_rate || 0),
      install_count: Number(template.usage_count || 0),
      quality_score: Number(template.confidence || 0) * Number(template.success_rate || 0),
    };
  }

  private scoreText(searchable: string, actionTokens: string[], detectedType: string | null, surfaces: string[]): number {
    let score = 0;
    for (const token of actionTokens) {
      if (token.length >= 3 && searchable.includes(token)) score += 0.08;
    }
    if (detectedType && searchable.includes(detectedType)) score += 0.3;
    for (const surface of surfaces) {
      if (searchable.includes(surface)) score += 0.12;
    }
    return score;
  }

  private extractTokens(value: string): string[] {
    return this.searchableText([value])
      .split(' ')
      .filter((token) => token.length >= 3 && !['the', 'and', 'for', 'with', 'this', 'that'].includes(token));
  }

  private searchableText(values: unknown[]): string {
    return values
      .map((value) => typeof value === 'string' ? value : JSON.stringify(value || ''))
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeToken(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return normalized || null;
  }

  private detectType(action: string): string | null {
    const text = action.toLowerCase();
    const checks: Array<[string, RegExp]> = [
      ['deploy', /\b(deploy|release|production|worker|pages)\b/],
      ['publish', /\b(publish|npm|package|registry)\b/],
      ['migration', /\b(migrate|migration|schema|d1|database|sql)\b/],
      ['security', /\b(security|audit|token|secret|key|credential|rotate)\b/],
      ['merge', /\b(merge|pull request|pr|github)\b/],
      ['docs', /\b(docs|documentation|readme)\b/],
    ];
    return checks.find(([, pattern]) => pattern.test(text))?.[0] || null;
  }

  private detectSurfaces(action: string, provided: string[], context: Record<string, unknown>): string[] {
    const values = [action, ...provided, JSON.stringify(context || {})].join(' ').toLowerCase();
    const surfaces = ['github', 'cloudflare', 'wrangler', 'npm', 'docs', 'database', 'd1', 'api', 'production'];
    return Array.from(new Set([
      ...provided.map((surface) => this.normalizeToken(surface)).filter((surface): surface is string => Boolean(surface)),
      ...surfaces.filter((surface) => values.includes(surface)),
    ]));
  }

  private inferRiskLevel(action: string, detectedType: string | null, surfaces: string[]): string {
    const text = action.toLowerCase();
    if (surfaces.includes('production') || /\b(production|prod|billing|credential|secret|token)\b/.test(text)) return 'high';
    if (['deploy', 'publish', 'migration', 'security', 'merge'].includes(detectedType || '')) return 'medium';
    return 'low';
  }

  private highestRiskLevel(...levels: Array<string | null>): string {
    const rank: Record<string, number> = { low: 0, medium: 1, high: 2 };
    return levels.reduce((highest, level) => {
      const normalized = level && rank[level] != null ? level : 'low';
      return rank[normalized] > rank[highest] ? normalized : highest;
    }, 'low');
  }

  private requiresOwnerApproval(riskLevel: string, detectedTypes: string[], surfaces: string[]): boolean {
    if (riskLevel === 'high') return true;
    if (surfaces.includes('production')) return true;
    return detectedTypes.some((type) => ['deploy', 'publish', 'migration', 'security', 'billing'].includes(type));
  }

  private buildReason(detectedType: string | null, surfaces: string[], category: string | null, tags: string): string {
    const parts = [];
    if (detectedType) parts.push(`task type ${detectedType}`);
    if (surfaces.length) parts.push(`surfaces ${surfaces.slice(0, 4).join(', ')}`);
    if (category) parts.push(`category ${category}`);
    if (tags) parts.push('matching tags or steps');
    return parts.length ? `Matched ${parts.join('; ')}.` : 'Matched action wording against template content.';
  }

  private humanizeTemplateName(templateId: string, fallback: string): string {
    const cleaned = templateId
      .replace(/^tpl[_-]?/i, '')
      .replace(/[_-]+/g, ' ')
      .trim();
    const base = cleaned || fallback || 'workflow';
    return base.replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  private clampScore(score: number): number {
    return Math.max(0, Math.min(0.99, Number(score.toFixed(2))));
  }
}
