import { Router, type IRequest } from 'itty-router';
import type { Env, RequestContext } from '../types';
import { getServices } from '../lib/services';
import { ok, fail } from '../lib/response';
import { withAuth } from '../middleware/auth';
import { withErrorBoundary } from '../middleware/error-boundary';
import { safely } from '../utils/safely';

function getUrl(request: IRequest): URL {
  return new URL(request.url);
}

function authRoute(handler: (request: IRequest, env: Env, ctx: RequestContext) => Promise<Response>): (request: IRequest, env: Env) => Promise<Response> {
  return withErrorBoundary(withAuth(async (request: IRequest, env: Env) => handler(request, env, request.ctx as RequestContext)));
}

async function createDecisionHandler(request: IRequest, env: Env, ctx: RequestContext): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;
  const services = getServices(env);
  const decisionService = services.decisions;
  const enterpriseService = services.enterprise;

  const validation = decisionService.validateDecision(body);
  if (!validation.valid) return fail('BAD_REQUEST', 'Validation failed', 400, validation.errors as Record<string, string>);

  const safety = enterpriseService.checkDecisionSafety(
    String(body.decision_type),
    body.context as Record<string, unknown>,
    String(body.outcome),
  );

  void Promise.all([
    ...safety.violations.filter((v) => v.severity === 'critical').map((v) =>
      enterpriseService.recordViolation(null, v.type, 'critical', 'block')
    ),
    ...safety.violations.map((v) =>
      enterpriseService.recordViolation(null, v.type, v.severity as 'low' | 'medium' | 'high' | 'critical', v.action)
    ),
  ]).catch((error) => {
    safely(() => console.warn('[decision-safety]', error), 'decision-safety');
  });

  let orgPiiStripTeam = false;
  let orgDefaultVisibility: 'private' | 'shared' | 'hive' | 'team' | null = null;
  const requestedVis = (body.visibility as string) || null;
  if (ctx.tier === 'enterprise') {
    const org = await services.org.getOrgForAccount(ctx.account_id);
    if (org) {
      orgPiiStripTeam = !!org.pii_strip_team;
      if (!requestedVis && org.default_visibility) {
        orgDefaultVisibility = org.default_visibility as 'private' | 'shared' | 'hive' | 'team';
      }
    }
  }

  const outcomeStr = String(body.outcome || '');
  const strippedOutcome = services.pii.stripString(outcomeStr);
  const decisionSanitized = strippedOutcome !== outcomeStr;

  const decision = await decisionService.createDecision(
    ctx.account_id,
    String(body.decision_type),
    body.context as Record<string, unknown>,
    outcomeStr,
    Number(body.confidence),
    (body.visibility as 'private' | 'shared' | 'hive' | 'team') || orgDefaultVisibility || 'hive',
    ctx.tier,
    orgPiiStripTeam,
  );

  return ok({ ...decision, sanitized: decisionSanitized }, 201);
}

async function listDecisionsHandler(request: IRequest, env: Env, ctx: RequestContext): Promise<Response> {
  const url = getUrl(request);
  const decisions = await getServices(env).decisions.listDecisions(ctx.account_id, {
    decision_type: url.searchParams.get('decision_type') || undefined,
    limit: parseInt(url.searchParams.get('limit') || '50'),
    offset: parseInt(url.searchParams.get('offset') || '0'),
  });
  return ok(decisions);
}

export const router = Router();

router.post('/decisions', authRoute(createDecisionHandler));
router.post('/v1/decisions', authRoute(createDecisionHandler));
router.get('/decisions', authRoute(listDecisionsHandler));
router.get('/v1/decisions', authRoute(listDecisionsHandler));

router.get('/v1/decisions/shared', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const shared = await getServices(env).collaboration.getSharedDecisions(
    ctx.account_id,
    parseInt(url.searchParams.get('limit') || '50'),
    parseInt(url.searchParams.get('offset') || '0'),
  );
  return ok(shared);
}));

router.get('/v1/decisions/routing-suggestions', authRoute(async (request: IRequest, env: Env) => {
  const url = getUrl(request);
  const decisionType = url.searchParams.get('decision_type') || 'general';
  const { similar: suggestions } = await getServices(env).patterns.predictSimilarDecisions({ type: decisionType }, decisionType, 5);
  return ok({ routing_suggestions: suggestions });
}));

router.get('/v1/decisions/priority', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const queue = await getServices(env).priority.getQueueByPriority(ctx.account_id, parseInt(url.searchParams.get('limit') || '50'));
  return ok(queue);
}));

router.get('/v1/decisions/:id', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const decision = await getServices(env).decisions.getDecision(String(request.params?.id), ctx.account_id);
  if (!decision) return fail('NOT_FOUND', 'Not found', 404);
  return ok(decision);
}));

router.put('/v1/decisions/:id/outcome', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  const outcome = await getServices(env).feedback.recordOutcome(
    String(request.params?.id),
    ctx.account_id,
    Boolean(body.success),
    body.feedback as string | undefined,
    body.details as Record<string, unknown> | undefined,
  );
  return ok(outcome);
}));

router.get('/v1/decisions/:id/outcome', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const outcome = await getServices(env).feedback.getOutcome(String(request.params?.id), ctx.account_id);
  if (!outcome) return fail('NOT_FOUND', 'Not found', 404);
  return ok(outcome);
}));

router.get('/v1/decisions/feedback/history', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const history = await getServices(env).feedback.getOutcomeHistory(
    ctx.account_id,
    parseInt(url.searchParams.get('limit') || '50'),
    parseInt(url.searchParams.get('offset') || '0'),
  );
  return ok(history);
}));

router.get('/v1/feedback/metrics', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const metrics = await getServices(env).feedback.getSuccessMetrics(ctx.account_id, url.searchParams.get('decision_type') || undefined);
  return ok(metrics);
}));

export default router;
