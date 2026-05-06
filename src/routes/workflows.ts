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

export const router = Router();

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

  const workflowAfterAgentId = request.headers.get('X-Marrow-Agent-Id');
  const result = await getServices(env).workflow.after({
    decision_id: String(body.decision_id || ''),
    success: Boolean(body.success),
    outcome: String(body.outcome || ''),
    related_decision_id: body.related_decision_id ? String(body.related_decision_id) : undefined,
    agent_id: workflowAfterAgentId || undefined,
  }, ctx.account_id);

  const response: Record<string, unknown> = { ...result };
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
