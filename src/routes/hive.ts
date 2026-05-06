import { Router, type IRequest } from 'itty-router';
import type { Env, RequestContext } from '../types';
import { getServices } from '../lib/services';
import { ok, fail } from '../lib/response';
import { withAuth } from '../middleware/auth';
import { withErrorBoundary } from '../middleware/error-boundary';

function getUrl(request: IRequest): URL {
  return new URL(request.url);
}

function authRoute(handler: (request: IRequest, env: Env, ctx: RequestContext) => Promise<Response>): (request: IRequest, env: Env) => Promise<Response> {
  return withErrorBoundary(withAuth(async (request: IRequest, env: Env) => handler(request, env, request.ctx as RequestContext)));
}

export const router = Router();

router.post('/v1/decisions/:id/prioritize', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  const urgencyOptions = ['low', 'normal', 'high', 'critical'];
  if (!body.urgency || !urgencyOptions.includes(String(body.urgency))) {
    return fail('BAD_REQUEST', 'urgency is required and must be one of: low, normal, high, critical', 400);
  }
  if (!body.impact || typeof body.impact !== 'number' || body.impact < 0 || body.impact > 1) {
    return fail('BAD_REQUEST', 'impact is required and must be a number between 0-1', 400);
  }
  const priority = await getServices(env).priority.calculatePriority(
    String(request.params?.id),
    ctx.account_id,
    String(body.urgency) as 'low' | 'normal' | 'high' | 'critical',
    Number(body.impact),
  );
  return ok(priority);
}));

router.get('/v1/queue/status', authRoute(async (_request: IRequest, env: Env, ctx: RequestContext) => {
  const status = await getServices(env).priority.getQueueStatus(ctx.account_id);
  return ok(status);
}));

router.get('/v1/hive', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const sort = url.searchParams.get('sort') || 'priority';
  if (sort !== 'priority') return fail('BAD_REQUEST', 'Invalid sort parameter', 400);

  const patterns = getServices(env).patterns;
  await patterns.recalculatePriorities(ctx.account_id);
  const result = await patterns.getHiveByPriority(url.searchParams.get('decision_type') || 'general', 50, ctx.account_id);
  return ok(result);
}));

router.get('/v1/hive/signals', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const signals = await getServices(env).patterns.getSignalsByAccountAndType(
    ctx.account_id,
    url.searchParams.get('decision_type') || 'general',
    parseInt(url.searchParams.get('limit') || '20'),
  );
  return ok({ signals });
}));

router.get('/v1/bootstrap', authRoute(async (request: IRequest, env: Env) => {
  const url = getUrl(request);
  const templates = await getServices(env).bootstrap.getTemplates(url.searchParams.get('decision_type') || 'general');
  return ok(templates);
}));

router.get('/v1/bootstrap/categories', authRoute(async (_request: IRequest, env: Env) => {
  const categories = await getServices(env).bootstrap.listCategories();
  return ok({ categories });
}));

router.post('/v1/bootstrap/:id/apply', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  const result = await getServices(env).bootstrap.applyTemplate(
    String(request.params?.id),
    ctx.account_id,
    body.custom_params as Record<string, unknown> | undefined,
  );
  return ok(result, 201);
}));

router.post('/v1/bootstrap', authRoute(async (request: IRequest, env: Env) => {
  const body = await request.json() as Record<string, unknown>;
  const template = await getServices(env).bootstrap.createTemplate(
    String(body.decision_type),
    body.template_decisions as unknown[],
    Number(body.success_rate || 0.5),
    String(body.category || 'general'),
  );
  return ok(template, 201);
}));

router.get('/v1/audit', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const result = await getServices(env).audit.getAuditLog({
    account_id: ctx.account_id,
    start_time: url.searchParams.get('start_time') || undefined,
    end_time: url.searchParams.get('end_time') || undefined,
    resource_type: url.searchParams.get('resource_type') || undefined,
    limit: parseInt(url.searchParams.get('limit') || '100'),
  });
  return ok(result);
}));

router.get('/v1/audit/verify', authRoute(async (_request: IRequest, env: Env) => {
  const result = await getServices(env).audit.verifyChain();
  return ok(result);
}));

router.post('/v1/decisions/:id/consensus-vote', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  const voteType = String(body.vote_type || (body.agrees ? 'agree' : 'disagree')) as 'agree' | 'disagree' | 'abstain';
  const vote = await getServices(env).consensus.recordVote(
    String(request.params?.id),
    ctx.account_id,
    voteType,
    body.reasoning as string | undefined,
  );
  return ok(vote, 201);
}));

router.get('/v1/hive/consensus', authRoute(async (request: IRequest, env: Env) => {
  const url = getUrl(request);
  const result = await getServices(env).consensus.getHiveConsensus(
    url.searchParams.get('decision_type') || 'general',
    parseInt(url.searchParams.get('limit') || '50'),
  );
  return ok(result);
}));

router.get('/v1/consensus/metrics', authRoute(async (request: IRequest, env: Env) => {
  const url = getUrl(request);
  const analysis = await getServices(env).consensus.detectDisagreement(
    url.searchParams.get('decision_id') || '',
    parseFloat(url.searchParams.get('threshold') || '0.3'),
  );
  return ok(analysis);
}));

router.post('/v1/snapshots', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  const result = await getServices(env).snapshot.createSnapshot(
    ctx.account_id,
    body.label as string | undefined,
    body.tags as string[] | undefined,
  );
  return ok(result, 201);
}));

router.get('/v1/snapshots', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const snapshots = await getServices(env).snapshot.listSnapshots(ctx.account_id, parseInt(url.searchParams.get('limit') || '50'));
  return ok(snapshots);
}));

router.get('/v1/snapshots/:id', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const snapshot = await getServices(env).snapshot.getSnapshot(String(request.params?.id), ctx.account_id);
  if (!snapshot) return fail('NOT_FOUND', 'Not found', 404);
  return ok(snapshot);
}));

router.post('/v1/snapshots/:id/diff', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  const diff = await getServices(env).snapshot.diffSnapshot(
    String(request.params?.id),
    String(body.comparison_snapshot_id),
    ctx.account_id,
  );
  return ok(diff);
}));

router.post('/v1/snapshots/:id/restore', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const result = await getServices(env).snapshot.restoreSnapshot(String(request.params?.id), ctx.account_id);
  return ok(result);
}));

router.get('/v1/restore/status', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const status = await getServices(env).snapshot.getRestoreStatus(url.searchParams.get('restore_id') || '', ctx.account_id);
  if (!status) return fail('NOT_FOUND', 'Not found', 404);
  return ok(status);
}));

router.delete('/v1/snapshots/:id', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  await getServices(env).snapshot.deleteSnapshot(String(request.params?.id), ctx.account_id);
  return ok({ deleted: true });
}));

router.get('/v1/versions', authRoute(async (_request: IRequest, env: Env) => {
  const versions = await getServices(env).version.getVersions();
  return ok(versions);
}));

router.get('/v1/versions/current', authRoute(async (_request: IRequest, env: Env) => {
  const version = await getServices(env).version.getCurrentVersion();
  if (!version) return fail('NOT_FOUND', 'No current version', 404);
  return ok(version);
}));

router.get('/v1/versions/:from/migration/:to', authRoute(async (request: IRequest, env: Env) => {
  const guide = await getServices(env).version.getMigrationGuide(String(request.params?.from), String(request.params?.to));
  if (!guide) return fail('NOT_FOUND', 'Migration guide not found', 404);
  return ok(guide);
}));

export default router;
