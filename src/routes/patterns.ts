import { Router, type IRequest } from 'itty-router';
import type { Env, RequestContext } from '../types';
import { getServices } from '../lib/services';
import { ok } from '../lib/response';
import { withAuth } from '../middleware/auth';
import { withErrorBoundary } from '../middleware/error-boundary';

function getUrl(request: IRequest): URL {
  return new URL(request.url);
}

function authRoute(handler: (request: IRequest, env: Env, ctx: RequestContext) => Promise<Response>): (request: IRequest, env: Env) => Promise<Response> {
  return withErrorBoundary(withAuth(async (request: IRequest, env: Env) => handler(request, env, request.ctx as RequestContext)));
}

export const router = Router();

router.post('/v1/decisions/predict', authRoute(async (request: IRequest, env: Env) => {
  const body = await request.json() as Record<string, unknown>;
  const { similar } = await getServices(env).patterns.predictSimilarDecisions(
    body.context as Record<string, unknown>,
    String(body.decision_type),
    5,
  );
  return ok({ similar_decisions: similar });
}));

router.get('/v1/patterns', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const patterns = await getServices(env).patterns.recognizePatterns(
    ctx.account_id,
    url.searchParams.get('decision_type') || undefined,
  );
  return ok(patterns);
}));

router.get('/v1/patterns/:id', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const stats = await getServices(env).patterns.getPatternStats(String(request.params?.id), ctx.account_id);
  return ok(stats);
}));

router.post('/v1/patterns/:id/validate', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  const result = await getServices(env).patterns.validatePattern(
    String(request.params?.id),
    String(body.decision_id),
    ctx.account_id,
  );
  return ok(result);
}));

router.get('/v1/trends', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const result = await getServices(env).patterns.calculateTrends(
    ctx.account_id,
    url.searchParams.get('decision_type') || 'general',
  );
  return ok(result);
}));

router.get('/v1/lessons/transfer', authRoute(async (request: IRequest, env: Env) => {
  const url = getUrl(request);
  const lessons = await getServices(env).transfer.getTransferableLessons(
    url.searchParams.get('from_type') || 'general',
    url.searchParams.get('to_type') || 'general',
    parseInt(url.searchParams.get('limit') || '10'),
  );
  return ok(lessons);
}));

router.post('/v1/lessons/:id/transfer-to', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  const result = await getServices(env).transfer.transferLesson(
    String(request.params?.id),
    ctx.account_id,
    String(body.from_domain),
    String(body.to_domain),
  );
  return ok(result, 201);
}));

router.get('/v1/transfer-metrics', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const metrics = await getServices(env).transfer.calculateTransferMetrics(
    ctx.account_id,
    url.searchParams.get('from_domain') || 'general',
    url.searchParams.get('to_domain') || 'general',
  );
  return ok(metrics);
}));

export default router;
