import { Router, type IRequest } from 'itty-router';
import type { Env, RequestContext } from '../types';
import { getServices } from '../lib/services';
import { ok, fail } from '../lib/response';
import { withAuth } from '../middleware/auth';
import { withErrorBoundary } from '../middleware/error-boundary';

function authRoute(handler: (request: IRequest, env: Env, ctx: RequestContext) => Promise<Response>): (request: IRequest, env: Env) => Promise<Response> {
  return withErrorBoundary(withAuth(async (request: IRequest, env: Env) => handler(request, env, request.ctx as RequestContext)));
}

export const router = Router();

router.post('/v1/decisions/:id/share', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  if (!body.trust_score || typeof body.trust_score !== 'number' || body.trust_score < 0 || body.trust_score > 1) {
    return fail('BAD_REQUEST', 'trust_score is required and must be a number between 0-1', 400);
  }
  if (!body.shared_with_account_id || typeof body.shared_with_account_id !== 'string' || String(body.shared_with_account_id).trim() === '') {
    return fail('BAD_REQUEST', 'shared_with_account_id is required and must be a non-empty string', 400);
  }
  const share = await getServices(env).collaboration.shareDecision(
    String(request.params?.id),
    ctx.account_id,
    String(body.shared_with_account_id),
    Number(body.trust_score),
  );
  return ok(share, 201);
}));

router.post('/v1/decisions/:id/caused-by', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  if (!body.cause_id || typeof body.cause_id !== 'string' || String(body.cause_id).trim() === '') {
    return fail('BAD_REQUEST', 'cause_id is required and must be a non-empty string', 400);
  }
  const edge = await getServices(env).causality.addCausalityEdge(
    String(body.cause_id),
    String(request.params?.id),
    String(body.reasoning),
    ctx.account_id,
    Number(body.strength || 1.0),
  );
  return ok(edge, 201);
}));

router.get('/v1/decisions/:id/causality', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const graph = await getServices(env).causality.getCausalityGraph(String(request.params?.id), ctx.account_id);
  return ok(graph);
}));

export default router;
