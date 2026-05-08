import { Router, type IRequest } from 'itty-router';
import type { Env, RequestContext } from '../types';
import { getServices } from '../lib/services';
import { ok, fail } from '../lib/response';
import { withAuth } from '../middleware/auth';
import { withErrorBoundary } from '../middleware/error-boundary';
import { actionQualityWarning, isStrictQualityMode, validateActionQuality } from '../middleware/action-validator';
import { checkRateLimit } from '../utils/rate-limit';

function getUrl(request: IRequest): URL {
  return new URL(request.url);
}

function authRoute(handler: (request: IRequest, env: Env, ctx: RequestContext) => Promise<Response>): (request: IRequest, env: Env) => Promise<Response> {
  return withErrorBoundary(withAuth(async (request: IRequest, env: Env) => handler(request, env, request.ctx as RequestContext)));
}

function boundAgentIds(ctx: RequestContext): string[] | null {
  if (ctx.agent_ids && ctx.agent_ids.length > 0) return ctx.agent_ids;
  if (ctx.agent_id) return [ctx.agent_id];
  return null;
}

function scopedHeaderAgent(ctx: RequestContext, headerAgent: string | null): string | null {
  const bound = boundAgentIds(ctx);
  if (!bound) return headerAgent;
  return bound[0] || null;
}

async function forbidForeignDecisionForBoundAgent(
  db: D1Database,
  ctx: RequestContext,
  decisionId: string,
): Promise<Response | null> {
  const bound = boundAgentIds(ctx);
  if (!bound) return null;
  const row = await db.prepare(`
    SELECT agent_id, session_id
    FROM decisions
    WHERE account_id = ? AND id = ?
    LIMIT 1
  `).bind(ctx.account_id, decisionId).first<{ agent_id: string | null; session_id: string | null }>();
  if (!row) return fail('NOT_FOUND', 'Decision not found or unauthorized', 404);
  if ((row.agent_id && bound.includes(row.agent_id)) || (row.session_id && bound.includes(row.session_id))) {
    return null;
  }
  return fail('FORBIDDEN', 'Agent-bound key cannot commit another agent decision', 403);
}

function actionQualityError(result: Exclude<ReturnType<typeof validateActionQuality>, { valid: true }>): Response {
  return new Response(JSON.stringify({
    error: result.code,
    message: result.message,
    ...(result.hint ? { hint: result.hint } : {}),
  }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_RISK_TOLERANCE = 'medium';
const HIGH_RISK_TERMS = /\b(?:auth|authentication|authorization|billing|cloudflare|customer data|database|db|delete|deploy|deployment|environment|key|migrate|migration|payment|permission|production|prod|revoke|rotate|secret|token|worker)\b/i;
const MEDIUM_RISK_TERMS = /\b(?:commit|config|configure|dependency|github|install|merge|package|pr|push|release|rollback|upgrade)\b/i;
const MAX_SCAN_TEXT_LENGTH = 1024;
const MAX_RISK_INPUT_LENGTH = 4096;
const MAX_CONTEXT_DEPTH = 4;
const MAX_CONTEXT_ENTRIES = 25;
const MAX_CONTEXT_STRING_LENGTH = 256;
const MAX_CONTEXT_KEY_LENGTH = 64;
const MAX_HINT_LENGTH = 128;
const HINT_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type RiskLevel = 'low' | 'medium' | 'high';
type RiskTolerance = 'low' | 'medium' | 'high';
type GateDecision = 'allow' | 'warn' | 'review_required' | 'block';

interface GateReason {
  code: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
}

function parseRiskTolerance(value: unknown): RiskTolerance {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return DEFAULT_RISK_TOLERANCE;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeContextForRisk(context: unknown, depth = 0): string {
  if (context == null) return '';
  if (typeof context === 'string') return truncateText(context, MAX_CONTEXT_STRING_LENGTH);
  if (typeof context === 'number' || typeof context === 'boolean' || typeof context === 'bigint') return String(context);
  if (typeof context !== 'object') return '';
  if (depth >= MAX_CONTEXT_DEPTH) return '[truncated]';

  if (Array.isArray(context)) {
    const items = context
      .slice(0, MAX_CONTEXT_ENTRIES)
      .map((value) => summarizeContextForRisk(value, depth + 1))
      .filter(Boolean);
    const suffix = context.length > MAX_CONTEXT_ENTRIES ? ',...' : '';
    return `[${items.join(',')}${suffix}]`;
  }

  const objectContext = context as Record<string, unknown>;
  const entries: string[] = [];
  let entryCount = 0;
  for (const key in objectContext) {
    if (!Object.prototype.hasOwnProperty.call(objectContext, key)) continue;
    entryCount += 1;
    if (entries.length >= MAX_CONTEXT_ENTRIES) continue;

    const value = summarizeContextForRisk(objectContext[key], depth + 1);
    if (value) entries.push(`${truncateText(key, MAX_CONTEXT_KEY_LENGTH)}:${value}`);
  }

  const suffix = entryCount > MAX_CONTEXT_ENTRIES ? ',...' : '';
  return `{${entries.join(',')}${suffix}}`;
}

function sanitizeHintId(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_HINT_LENGTH) return null;
  return HINT_ID_REGEX.test(trimmed) ? trimmed : null;
}

function classifyActionRisk(action: string, description: string, context: unknown): RiskLevel {
  const text = truncateText(
    `${truncateText(action, MAX_SCAN_TEXT_LENGTH)} ${truncateText(description, MAX_SCAN_TEXT_LENGTH)} ${summarizeContextForRisk(context)}`,
    MAX_RISK_INPUT_LENGTH,
  );
  if (HIGH_RISK_TERMS.test(text)) return 'high';
  if (MEDIUM_RISK_TERMS.test(text)) return 'medium';
  return 'low';
}

function evaluateGate(input: {
  action: string;
  description: string;
  context: unknown;
  riskTolerance: RiskTolerance;
  requiresApproval: boolean;
}): { allow: boolean; decision: GateDecision; risk_level: RiskLevel; reasons: GateReason[] } {
  const reasons: GateReason[] = [];
  const qualityResult = validateActionQuality(input.description || input.action);
  const riskLevel = classifyActionRisk(input.action, input.description, input.context);

  if (!qualityResult.valid) {
    reasons.push({
      code: qualityResult.code,
      severity: 'high',
      message: qualityResult.message,
    });
    return { allow: false, decision: 'block', risk_level: riskLevel, reasons };
  }

  if (input.requiresApproval) {
    reasons.push({
      code: 'approval_required',
      severity: 'high',
      message: 'Action explicitly requires approval before execution',
    });
    return { allow: false, decision: 'review_required', risk_level: riskLevel, reasons };
  }

  if (riskLevel === 'high' && input.riskTolerance !== 'high') {
    reasons.push({
      code: 'high_risk_action',
      severity: 'high',
      message: 'High-risk action should be reviewed before execution',
    });
    return { allow: false, decision: 'review_required', risk_level: riskLevel, reasons };
  }

  if (riskLevel === 'medium' && input.riskTolerance === 'low') {
    reasons.push({
      code: 'medium_risk_action',
      severity: 'medium',
      message: 'Medium-risk action exceeds low risk tolerance',
    });
    return { allow: true, decision: 'warn', risk_level: riskLevel, reasons };
  }

  if (riskLevel !== 'low') {
    reasons.push({
      code: `${riskLevel}_risk_action`,
      severity: riskLevel,
      message: `${riskLevel[0].toUpperCase()}${riskLevel.slice(1)}-risk action detected`,
    });
    return { allow: true, decision: 'warn', risk_level: riskLevel, reasons };
  }

  return { allow: true, decision: 'allow', risk_level: riskLevel, reasons };
}

export const router = Router();

router.post('/v1/workflow/gate', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const rlAllowed = await checkRateLimit(env.DB, `workflow_gate:${ctx.account_id}`, 120, 60 * 1000);
  if (!rlAllowed) return fail('RATE_LIMITED', 'Rate limited', 429);

  const body = await request.json() as Record<string, unknown>;
  if (!body.action || typeof body.action !== 'string') {
    return fail('BAD_REQUEST', 'Missing required field: action', 400);
  }

  const action = body.action.trim();
  if (!action) return fail('BAD_REQUEST', 'Missing required field: action', 400);

  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const riskTolerance = parseRiskTolerance(body.risk_tolerance);
  const strictQualityMode = isStrictQualityMode(env, ctx);
  const result = evaluateGate({
    action,
    description,
    context: body.context,
    riskTolerance,
    requiresApproval: body.requires_approval === true,
  });

  const agentIdHint = sanitizeHintId(scopedHeaderAgent(ctx, request.headers.get('X-Marrow-Agent-Id')));
  const sessionIdHint = sanitizeHintId(request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id'));
  const services = getServices(env);
  const policy = {
    mode: strictQualityMode ? 'strict' : 'advisory',
    risk_tolerance: riskTolerance,
    side_effects: 'metadata_log_only',
  };
  const accessAgentIds = boundAgentIds(ctx);
  const canReadShared = await services.fleetLearning.canReadSharedFleet(ctx.account_id, accessAgentIds);
  const [gateEvent, lessons, deploymentMemory] = await Promise.all([
    services.fleetLearning.recordRiskGate(ctx.account_id, {
      agent_id: agentIdHint,
      session_id: sessionIdHint,
      action,
      risk_level: result.risk_level,
      decision: result.decision,
      allow: result.allow,
      reasons: result.reasons,
      policy,
    }).catch(() => null),
    services.fleetLearning.listLessons(ctx.account_id, {
      query: action,
      agent_id: canReadShared ? null : accessAgentIds?.[0],
      access_agent_ids: accessAgentIds,
      limit: 3,
    }).catch(() => []),
    result.risk_level !== 'low'
      ? services.fleetLearning.listDeploymentMemories(ctx.account_id, {
        agent_id: canReadShared ? null : accessAgentIds?.[0],
        access_agent_ids: accessAgentIds,
        limit: 3,
      }).catch(() => [])
      : Promise.resolve([]),
  ]);

  return ok({
    ...result,
    agent_id: agentIdHint,
    session_id: sessionIdHint,
    gate_event_id: gateEvent?.id || null,
    policy,
    prior_lessons: lessons,
    deployment_playbooks: deploymentMemory,
    next: {
      recommended_endpoint: result.allow ? '/v1/workflow/before' : null,
    },
  });
}));

router.post('/v1/workflow/before', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  if (!body.decision_type || !body.action || !body.description) {
    return fail('BAD_REQUEST', 'Missing required fields: decision_type, action, description', 400);
  }

  const qualityResult = validateActionQuality(String(body.description || body.action || ''));
  const strictQualityMode = isStrictQualityMode(env, ctx);
  if (!qualityResult.valid && strictQualityMode) {
    return actionQualityError(qualityResult);
  }

  const wfSessionId = request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null;
  const result = await getServices(env).workflow.before({
    decision_type: String(body.decision_type || ''),
    action: String(body.action || ''),
    description: String(body.description || ''),
    session_id: wfSessionId,
  }, ctx.account_id, ctx.tier);

  const response: Record<string, unknown> = { ...result };
  if (!qualityResult.valid && !strictQualityMode) {
    response.warnings = [...((result.warnings || []) as Record<string, unknown>[]), actionQualityWarning(qualityResult)];
  }
  return ok(response);
}));

router.post('/v1/workflow/after', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  if (!body.decision_id || body.success === undefined || !body.outcome) {
    return fail('BAD_REQUEST', 'Missing required fields: decision_id, success, outcome', 400);
  }

  const qualityResult = validateActionQuality(String(body.outcome || ''));
  const strictQualityMode = isStrictQualityMode(env, ctx);
  if (!qualityResult.valid && strictQualityMode) {
    return actionQualityError(qualityResult);
  }

  const workflowAfterAgentId = scopedHeaderAgent(ctx, request.headers.get('X-Marrow-Agent-Id'));
  const services = getServices(env);
  const scopedDecisionError = await forbidForeignDecisionForBoundAgent(env.DB, ctx, String(body.decision_id || ''));
  if (scopedDecisionError) return scopedDecisionError;
  const result = await services.workflow.after({
    decision_id: String(body.decision_id || ''),
    success: Boolean(body.success),
    outcome: String(body.outcome || ''),
    related_decision_id: body.related_decision_id ? String(body.related_decision_id) : undefined,
    agent_id: workflowAfterAgentId || undefined,
  }, ctx.account_id);

  const response: Record<string, unknown> = { ...result };
  const lesson = await services.fleetLearning.learnFromDecision(ctx.account_id, String(body.decision_id || ''), boundAgentIds(ctx)).catch(() => null);
  if (lesson) response.fleet_lesson = lesson;
  if (!qualityResult.valid && !strictQualityMode) {
    response.warnings = [actionQualityWarning(qualityResult)];
  }
  return ok(response);
}));

router.get('/v1/workflow/status', authRoute(async (_request: IRequest, env: Env, ctx: RequestContext) => {
  const result = await getServices(env).workflow.status(ctx.account_id);
  return ok(result);
}));

router.post('/v1/workflows/register', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  if (!body.name || !body.steps || !Array.isArray(body.steps)) {
    return fail('BAD_REQUEST', 'Bad request: name and steps required', 400);
  }
  const result = await getServices(env).workflowRegistry.register({
    name: String(body.name),
    description: typeof body.description === 'string' ? body.description : undefined,
    steps: body.steps as Array<{ step: number; agent_role?: string; action_type?: string; description: string }>,
    tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
  }, ctx.account_id);
  return ok(result, 201);
}));

router.get('/v1/workflows', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const status = getUrl(request).searchParams.get('status') || undefined;
  const workflows = await getServices(env).workflowRegistry.list(ctx.account_id, status);
  return ok({ workflows, count: workflows.length });
}));

router.get('/v1/workflows/:workflowId', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  try {
    const workflow = await getServices(env).workflowRegistry.getById(String(request.params?.workflowId), ctx.account_id);
    if (!workflow) return fail('NOT_FOUND', 'Not found', 404);
    return ok({ workflow });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg.includes('Invalid') || msg.includes('UUID')) return fail('BAD_REQUEST', 'Bad request', 400);
    throw e;
  }
}));

router.put('/v1/workflows/:workflowId', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  try {
    const workflow = await getServices(env).workflowRegistry.update(String(request.params?.workflowId), ctx.account_id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
      status: typeof body.status === 'string' ? body.status : undefined,
    });
    if (!workflow) return fail('NOT_FOUND', 'Not found', 404);
    return ok({ workflow });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg.includes('Invalid') || msg.includes('UUID')) return fail('BAD_REQUEST', 'Bad request', 400);
    if (msg.includes('transition')) return fail('BAD_REQUEST', 'Bad request', 400, { detail: msg });
    throw e;
  }
}));

router.post('/v1/workflows/:workflowId/start', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  try {
    const result = await getServices(env).workflowRegistry.start(String(request.params?.workflowId), ctx.account_id, {
      agent_id: ctx.account_id,
      context: body.context as Record<string, unknown> | undefined,
      inputs: body.inputs as Record<string, unknown> | undefined,
    });
    if (!result) return fail('NOT_FOUND', 'Workflow not found or not active', 404);
    return ok({ workflowInstanceId: result.workflowInstanceId, currentStep: result.currentStep, nextAction: result.nextAction }, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg.includes('Invalid') || msg.includes('UUID')) return fail('BAD_REQUEST', 'Bad request', 400);
    throw e;
  }
}));

router.put('/v1/workflows/:workflowId/instances/:instanceId/step', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  if (body.step_completed === undefined || body.outcome === undefined) {
    return fail('BAD_REQUEST', 'Bad request: step_completed and outcome required', 400);
  }

  try {
    const result = await getServices(env).workflowRegistry.advance(String(request.params?.instanceId), ctx.account_id, {
      step_completed: Number(body.step_completed),
      outcome: String(body.outcome),
      agent_id: typeof body.agent_id === 'string' ? body.agent_id : undefined,
      next_agent_id: typeof body.next_agent_id === 'string' ? body.next_agent_id : undefined,
      context_update: body.context_update as Record<string, unknown> | undefined,
      duration_ms: typeof body.duration_ms === 'number' ? body.duration_ms : undefined,
      token_count: typeof body.token_count === 'number' ? body.token_count : undefined,
    });

    if (!result) return fail('NOT_FOUND', 'Instance not found or not running', 404);
    return ok({
      currentStep: result.currentStep,
      nextAction: result.nextAction,
      isComplete: result.isComplete,
      workflowOutcome: result.workflowOutcome,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg.includes('Step order violation') || msg.includes('Agent role mismatch')) return fail('ERROR', msg, 409);
    if (msg.includes('Invalid') || msg.includes('UUID')) return fail('BAD_REQUEST', 'Bad request', 400);
    if (msg.includes('exceeds')) return fail('BAD_REQUEST', 'Bad request', 400, { detail: msg });
    throw e;
  }
}));

router.get('/v1/workflows/:workflowId/instances', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  try {
    const status = getUrl(request).searchParams.get('status') || undefined;
    const instances = await getServices(env).workflowRegistry.listInstances(String(request.params?.workflowId), ctx.account_id, status);
    return ok({ instances, count: instances.length });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg.includes('Invalid') || msg.includes('UUID')) return fail('BAD_REQUEST', 'Bad request', 400);
    throw e;
  }
}));

router.post('/v1/workflows/accept-detected', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const rlAllowed = await checkRateLimit(env.DB, `workflow_accept_detected:${ctx.account_id}`, 10, 60 * 1000);
  if (!rlAllowed) return fail('RATE_LIMITED', 'Rate limited', 429);

  const body = await request.json() as Record<string, unknown>;
  if (!body.detected_id || typeof body.detected_id !== 'string') {
    return fail('BAD_REQUEST', 'detected_id is required', 400);
  }
  if (!UUID_REGEX.test(String(body.detected_id))) {
    return fail('BAD_REQUEST', 'detected_id must be a valid UUID', 400);
  }

  const services = getServices(env);
  const result = await services.workflowDetection.acceptDetected(
    String(body.detected_id),
    ctx.account_id,
    services.workflowRegistry,
  );

  if (!result) return fail('NOT_FOUND', 'Detected workflow not found or already accepted', 404);
  return ok({ workflow_id: result.workflowId, version: result.version });
}));

export default router;
