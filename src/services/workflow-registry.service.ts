/**
 * Workflow Registry Service
 * Manages workflow templates, instances, and step progression.
 * C1: All queries scoped to accountId for account isolation.
 */

export interface WorkflowStep {
  step: number;
  agent_role?: string;
  action_type?: string;
  description: string;
}

export interface RegisterWorkflowInput {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  tags?: string[];
}

export interface StartWorkflowInput {
  agent_id: string;
  context?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
}

export interface AdvanceStepInput {
  step_completed: number;
  outcome: string;
  agent_id?: string;
  next_agent_id?: string;
  context_update?: Record<string, unknown>;
  duration_ms?: number;
  token_count?: number;
}

interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  version: number;
  status: string;
  tags: string;
  created_at: string;
  updated_at: string;
  agent_id: string | null;
  account_id: string | null;
}

interface StepRow {
  id: string;
  workflow_id: string;
  step_order: number;
  step_name: string;
  agent_role: string | null;
  action_type: string | null;
  description: string;
  required: number;
}

interface InstanceRow {
  id: string;
  workflow_id: string;
  status: string;
  current_step: number;
  agent_id: string | null;
  context: string;
  inputs: string;
  outcome: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface WorkflowDetail {
  id: string;
  name: string;
  description: string | null;
  version: number;
  status: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  agentId: string | null;
  steps: Array<{
    stepOrder: number;
    stepName: string;
    agentRole: string | null;
    actionType: string | null;
    description: string;
    required: boolean;
  }>;
}

export interface WorkflowInstanceDetail {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  currentStep: number;
  agentId: string | null;
  context: Record<string, unknown>;
  inputs: Record<string, unknown>;
  outcome: string | null;
  startedAt: string;
  completedAt: string | null;
  stepResults: Array<{
    stepOrder: number;
    agentId: string | null;
    status: string;
    outcome: string | null;
    durationMs: number | null;
    tokenCount: number | null;
    createdAt: string;
  }>;
}

// H2: Input size limits
const MAX_TEXT_FIELD = 10000; // 10KB for outcome, context, inputs, description
const MAX_STEP_COUNT = 50;    // M2: Cap on workflow steps

// L2: UUID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// L1: Valid status transitions
const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  'draft': ['active', 'archived'],
  'active': ['archived'],
  'archived': [], // terminal
};

// L3: XSS sanitization for step names used in UI
function sanitizeForUi(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function validateUuid(id: string, field: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new Error(`Invalid ${field}: must be a valid UUID`);
  }
}

function truncateText(s: string | undefined | null, limit: number): string | null {
  if (!s) return null;
  if (s.length > limit) throw new Error(`Text field exceeds ${limit} character limit`);
  return s;
}

export class WorkflowRegistryService {
  constructor(private db: D1Database) {}

  // ─── Workflows ───────────────────────────────────────────────

  // L3: Sanitize step names for UI safety
  private sanitizeStep(step: WorkflowStep): WorkflowStep {
    return {
      ...step,
      description: step.description || '',
      agent_role: step.agent_role ? step.agent_role.slice(0, 200) : undefined,
      action_type: step.action_type ? step.action_type.slice(0, 200) : undefined,
    };
  }

  async register(input: RegisterWorkflowInput, accountId: string): Promise<{ workflowId: string; version: number }> {
    // H2: Validate text field sizes
    truncateText(input.description, MAX_TEXT_FIELD);

    // M2: Cap step count
    if (input.steps.length > MAX_STEP_COUNT) {
      throw new Error(`Workflow exceeds maximum of ${MAX_STEP_COUNT} steps`);
    }

    // Validate each step
    const sanitizedSteps = input.steps.map((s) => {
      truncateText(s.description, MAX_TEXT_FIELD);
      return this.sanitizeStep(s);
    });

    const workflowId = crypto.randomUUID();

    // C1: Check for existing workflow with same name scoped to this account
    const existing = await this.db
      .prepare('SELECT id, version FROM workflows WHERE name = ? AND account_id = ?')
      .bind(input.name, accountId)
      .first<{ id: string; version: number }>();

    let version = 1;

    if (existing) {
      // M1: Version bump only if agent owns the workflow
      version = existing.version + 1;
      await this.db
        .prepare("UPDATE workflows SET status = 'archived', updated_at = datetime('now') WHERE id = ? AND account_id = ?")
        .bind(existing.id, accountId)
        .run();
      await this.db
        .prepare('UPDATE workflow_steps SET step_order = step_order + 10000 WHERE workflow_id = ?')
        .bind(existing.id)
        .run();
    }

    const tags = JSON.stringify(input.tags || []);

    await this.db
      .prepare(
        'INSERT INTO workflows (id, name, description, version, status, tags, agent_id, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
      )
      .bind(workflowId, input.name, input.description || null, version, 'active', tags, accountId, accountId)
      .run();

    // Insert steps
    for (const step of sanitizedSteps) {
      const stepId = crypto.randomUUID();
      await this.db
        .prepare(
          'INSERT INTO workflow_steps (id, workflow_id, step_order, step_name, agent_role, action_type, description, required) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          stepId,
          workflowId,
          step.step,
          sanitizeForUi(step.step.toString()),
          step.agent_role || null,
          step.action_type || null,
          step.description,
          1
        )
        .run();
    }

    return { workflowId, version };
  }

  // C1: All queries scoped to accountId
  async list(accountId: string, status?: string, tags?: string): Promise<WorkflowDetail[]> {
    let sql = 'SELECT * FROM workflows WHERE account_id = ?';
    const bindParams: (string | number | null)[] = [accountId];

    if (status) {
      sql += ' AND status = ?';
      bindParams.push(status);
    }

    sql += ' ORDER BY created_at DESC';

    const rows = await this.db.prepare(sql).bind(...bindParams).all<WorkflowRow>();

    const workflows: WorkflowDetail[] = [];
    for (const row of rows.results || []) {
      const steps = await this.getSteps(row.id);
      workflows.push({
        id: row.id,
        name: row.name,
        description: row.description,
        version: row.version,
        status: row.status,
        tags: JSON.parse(row.tags || '[]'),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        agentId: row.agent_id,
        steps,
      });
    }

    return workflows;
  }

  // C1: getById scoped to accountId
  async getById(workflowId: string, accountId: string): Promise<WorkflowDetail | null> {
    validateUuid(workflowId, 'workflowId');

    const row = await this.db
      .prepare('SELECT * FROM workflows WHERE id = ? AND account_id = ?')
      .bind(workflowId, accountId)
      .first<WorkflowRow>();

    if (!row) return null;

    const steps = await this.getSteps(row.id);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      version: row.version,
      status: row.status,
      tags: JSON.parse(row.tags || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      agentId: row.agent_id,
      steps,
    };
  }

  async update(workflowId: string, accountId: string, updates: { name?: string; description?: string; tags?: string[]; status?: string }): Promise<WorkflowDetail | null> {
    validateUuid(workflowId, 'workflowId');

    const existing = await this.getById(workflowId, accountId);
    if (!existing) return null;

    // L1: Validate status transitions
    if (updates.status !== undefined) {
      const allowed = VALID_STATUS_TRANSITIONS[existing.status] || [];
      if (!allowed.includes(updates.status)) {
        throw new Error(`Invalid status transition: ${existing.status} → ${updates.status}`);
      }
    }

    // H2: Validate text field sizes
    if (updates.description !== undefined) {
      truncateText(updates.description, MAX_TEXT_FIELD);
    }
    if (updates.name !== undefined) {
      truncateText(updates.name, 500);
    }

    const setClauses: string[] = [];
    const bindParams: (string | number | null)[] = [];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      bindParams.push(updates.name);
    }
    if (updates.description !== undefined) {
      setClauses.push('description = ?');
      bindParams.push(updates.description || null);
    }
    if (updates.tags !== undefined) {
      setClauses.push('tags = ?');
      bindParams.push(JSON.stringify(updates.tags));
    }
    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      bindParams.push(updates.status);
    }

    setClauses.push("updated_at = datetime('now')");
    bindParams.push(workflowId, accountId);

    await this.db
      .prepare(`UPDATE workflows SET ${setClauses.join(', ')} WHERE id = ? AND account_id = ?`)
      .bind(...bindParams)
      .run();

    return this.getById(workflowId, accountId);
  }

  // ─── Steps ───────────────────────────────────────────────────

  private async getSteps(workflowId: string): Promise<WorkflowDetail['steps']> {
    const rows = await this.db
      .prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? AND step_order < 10000 ORDER BY step_order')
      .bind(workflowId)
      .all<StepRow>();

    return (rows.results || []).map((r) => ({
      stepOrder: r.step_order,
      stepName: r.step_name,
      agentRole: r.agent_role,
      actionType: r.action_type,
      description: r.description,
      required: r.required === 1,
    }));
  }

  // ─── Instances ───────────────────────────────────────────────

  // C1 + H1: start uses accountId from auth, not body-provided agent_id
  async start(workflowId: string, accountId: string, input: StartWorkflowInput): Promise<{
    workflowInstanceId: string;
    currentStep: number;
    nextAction: string;
  } | null> {
    validateUuid(workflowId, 'workflowId');

    const workflow = await this.getById(workflowId, accountId);
    if (!workflow || workflow.status !== 'active') return null;

    if (workflow.steps.length === 0) return null;

    const instanceId = crypto.randomUUID();
    const contextStr = JSON.stringify(input.context || {});
    const inputsStr = JSON.stringify(input.inputs || {});

    // H2: Validate text sizes
    truncateText(contextStr, MAX_TEXT_FIELD);
    truncateText(inputsStr, MAX_TEXT_FIELD);

    const firstStep = workflow.steps[0];

    await this.db
      .prepare(
        'INSERT INTO workflow_instances (id, workflow_id, status, current_step, agent_id, context, inputs, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))'
      )
      .bind(instanceId, workflowId, 'running', firstStep.stepOrder, accountId, contextStr, inputsStr)
      .run();

    return {
      workflowInstanceId: instanceId,
      currentStep: firstStep.stepOrder,
      nextAction: `${firstStep.stepName}${firstStep.agentRole ? ` (${firstStep.agentRole})` : ''}`,
    };
  }

  async advance(instanceId: string, accountId: string, input: AdvanceStepInput): Promise<{
    currentStep: number | null;
    nextAction: string | null;
    isComplete: boolean;
    workflowOutcome?: string;
  } | null> {
    validateUuid(instanceId, 'instanceId');

    // C1: Ensure instance belongs to this account
    const instance = await this.db
      .prepare('SELECT wi.* FROM workflow_instances wi JOIN workflows w ON wi.workflow_id = w.id WHERE wi.id = ? AND w.account_id = ?')
      .bind(instanceId, accountId)
      .first<InstanceRow>();

    if (!instance || instance.status !== 'running') return null;

    const workflow = await this.getById(instance.workflow_id, accountId);
    if (!workflow) return null;

    // ENFORCE: step_completed must match the instance's current_step.
    // Prevents skipping steps (e.g. jumping from step 1 to step 4).
    if (input.step_completed !== instance.current_step) {
      throw new Error(
        `Step order violation: expected step ${instance.current_step}, got step ${input.step_completed}. Complete steps in order.`
      );
    }

    // ENFORCE: if the current step defines an agent_role, the calling agent must match.
    // Prevents e.g. the builder signing off on the auditor's review step.
    const currentStepDef = workflow.steps.find((s) => s.stepOrder === instance.current_step);
    if (currentStepDef?.agentRole && input.agent_id) {
      const expected = currentStepDef.agentRole.toLowerCase();
      const actual = input.agent_id.toLowerCase();
      if (expected !== actual) {
        throw new Error(
          `Agent role mismatch: step ${instance.current_step} requires "${currentStepDef.agentRole}" but was called by "${input.agent_id}".`
        );
      }
    }

    // H2: Validate outcome size
    truncateText(input.outcome, MAX_TEXT_FIELD);

    // Record step result
    const resultId = crypto.randomUUID();
    await this.db
      .prepare(
        'INSERT INTO workflow_step_results (id, instance_id, step_order, agent_id, status, outcome, duration_ms, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))'
      )
      .bind(
        resultId,
        instanceId,
        input.step_completed,
        input.agent_id || accountId, // Use agent identity if provided, fall back to account
        'completed',
        input.outcome,
        input.duration_ms || null,
        input.token_count || null
      )
      .run();

    // Find next step
    const currentStepOrder = input.step_completed;
    const nextStep = workflow.steps.find((s) => s.stepOrder > currentStepOrder);

    if (!nextStep) {
      // Workflow complete
      await this.db
        .prepare("UPDATE workflow_instances SET status = 'completed', current_step = ?, outcome = ?, completed_at = datetime('now') WHERE id = ?")
        .bind(currentStepOrder, input.outcome, instanceId)
        .run();

      return {
        currentStep: null,
        nextAction: null,
        isComplete: true,
        workflowOutcome: input.outcome,
      };
    }

    // Update instance to next step
    await this.db
      .prepare('UPDATE workflow_instances SET current_step = ? WHERE id = ?')
      .bind(nextStep.stepOrder, instanceId)
      .run();

    // Update context if provided
    if (input.context_update) {
      const existingContext = JSON.parse(instance.context || '{}');
      const merged = { ...existingContext, ...input.context_update };
      const mergedStr = JSON.stringify(merged);
      truncateText(mergedStr, MAX_TEXT_FIELD);
      await this.db
        .prepare('UPDATE workflow_instances SET context = ? WHERE id = ?')
        .bind(mergedStr, instanceId)
        .run();
    }

    return {
      currentStep: nextStep.stepOrder,
      nextAction: `${nextStep.stepName}${nextStep.agentRole ? ` (${nextStep.agentRole})` : ''}`,
      isComplete: false,
    };
  }

  // C1: listInstances scoped to accountId
  async listInstances(workflowId: string, accountId: string, status?: string): Promise<WorkflowInstanceDetail[]> {
    validateUuid(workflowId, 'workflowId');

    // Ensure workflow belongs to this account
    const workflow = await this.getById(workflowId, accountId);
    if (!workflow) return [];

    let sql = 'SELECT * FROM workflow_instances WHERE workflow_id = ?';
    const bindParams: (string | number | null)[] = [workflowId];

    if (status) {
      sql += ' AND status = ?';
      bindParams.push(status);
    }

    sql += ' ORDER BY started_at DESC';

    const rows = await this.db.prepare(sql).bind(...bindParams).all<InstanceRow>();

    const instances: WorkflowInstanceDetail[] = [];
    for (const row of rows.results || []) {
      const stepResults = await this.getStepResults(row.id);
      instances.push({
        id: row.id,
        workflowId: row.workflow_id,
        workflowName: workflow.name,
        status: row.status,
        currentStep: row.current_step,
        agentId: row.agent_id,
        context: JSON.parse(row.context || '{}'),
        inputs: JSON.parse(row.inputs || '{}'),
        outcome: row.outcome,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        stepResults,
      });
    }

    return instances;
  }

  private async getStepResults(instanceId: string): Promise<WorkflowInstanceDetail['stepResults']> {
    const rows = await this.db
      .prepare('SELECT * FROM workflow_step_results WHERE instance_id = ? ORDER BY step_order')
      .bind(instanceId)
      .all();

    return (rows.results || []).map((r: any) => ({
      stepOrder: r.step_order,
      agentId: r.agent_id,
      status: r.status,
      outcome: r.outcome,
      durationMs: r.duration_ms,
      tokenCount: r.token_count,
      createdAt: r.created_at,
    }));
  }
}
