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

export const marketplaceRouter = Router();

// ============= LESSONS =============

marketplaceRouter.post('/v1/lessons', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  const title = String(body.title || '');
  const content = String(body.content || '');
  if (title.length > 200) return fail('BAD_REQUEST', 'Title max 200 characters', 400);
  if (content.length > 5000) return fail('BAD_REQUEST', 'Content max 5000 characters', 400);

  const lesson = await getServices(env).collaboration.createLesson(
    ctx.account_id, title, content,
    body.domain_tags as string[] | undefined,
  );
  return ok(lesson, 201);
}));

marketplaceRouter.post('/v1/lessons/:id/publish', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const result = await getServices(env).marketplace.publishLesson(
    String(request.params?.id), ctx.account_id,
  );
  return ok(result);
}));

marketplaceRouter.get('/v1/lessons/marketplace', authRoute(async (request: IRequest, env: Env, _ctx: RequestContext) => {
  const url = getUrl(request);
  const result = await getServices(env).marketplace.getMarketplace(
    (url.searchParams.get('sort_by') as 'rating' | 'reputation' | 'recent' | 'forks') || 'rating',
    parseInt(url.searchParams.get('limit') || '50'),
  );
  return ok(result);
}));

marketplaceRouter.post('/v1/lessons/:id/fork', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  if (!body.to_domain || typeof body.to_domain !== 'string' || String(body.to_domain).trim() === '') {
    return fail('BAD_REQUEST', 'to_domain is required and must be a non-empty string', 400);
  }
  const result = await getServices(env).marketplace.forkLesson(
    String(request.params?.id), ctx.account_id, String(body.to_domain),
  );
  return ok(result, 201);
}));

marketplaceRouter.post('/v1/lessons/:id/rate', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json() as Record<string, unknown>;
  if (!body.rating || typeof body.rating !== 'number' || body.rating < 1 || body.rating > 5) {
    return fail('BAD_REQUEST', 'rating is required and must be a number between 1-5', 400);
  }
  await getServices(env).marketplace.rateLesson(
    String(request.params?.id), ctx.account_id, Number(body.rating),
  );
  return ok({ rated: true });
}));

marketplaceRouter.get('/v1/lessons/:id/versions', authRoute(async (request: IRequest, env: Env, _ctx: RequestContext) => {
  const versions = await getServices(env).marketplace.getLessonVersions(String(request.params?.id));
  return ok(versions);
}));

// ============= TEMPLATES =============

// Public browsing endpoint. Keep this before /v1/templates/:slug so "learned"
// is not interpreted as a template slug.
marketplaceRouter.get('/v1/templates/learned', withErrorBoundary(async (request: IRequest, env: Env) => {
  const url = getUrl(request);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20') || 20, 100);
  const patterns = getServices(env).patterns;

  const countRow = await env.DB
    .prepare('SELECT COUNT(*) as c FROM learned_templates')
    .first<{ c: number }>();
  const refreshed = (countRow?.c || 0) === 0;
  if (refreshed) {
    await patterns.learnTemplates().catch((error: unknown) => {
      console.error('[sync-learn]', error instanceof Error ? error.message : error);
    });
  }

  const templates = await patterns.getLearnedTemplates(limit);
  return ok({ templates, refreshed });
}));

marketplaceRouter.get('/v1/templates', authRoute(async (request: IRequest, env: Env, _ctx: RequestContext) => {
  const url = getUrl(request);
  const templates = await getServices(env).templates.listTemplates({
    industry: url.searchParams.get('industry') || undefined,
    category: url.searchParams.get('category') || undefined,
    search: url.searchParams.get('search') || undefined,
    limit: parseInt(url.searchParams.get('limit') || '20'),
  });
  return ok(templates);
}));

marketplaceRouter.get('/v1/templates/:slug', authRoute(async (request: IRequest, env: Env, _ctx: RequestContext) => {
  const template = await getServices(env).templates.getTemplate(String(request.params?.slug));
  if (!template) return fail('NOT_FOUND', 'Template not found', 404);
  return ok(template);
}));

marketplaceRouter.post('/v1/templates/:slug/install', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  try {
    const result = await getServices(env).templates.installTemplate(
      String(request.params?.slug), ctx.account_id,
    );
    return ok(result, 201);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Internal error';
    return fail('BAD_REQUEST', msg, 400);
  }
}));

marketplaceRouter.post('/v1/templates', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const body = await request.json?.() as Record<string, unknown> | undefined;
  if (!body?.name || typeof body.name !== 'string') return fail('BAD_REQUEST', 'name is required', 400);
  if (!body.steps || !Array.isArray(body.steps)) return fail('BAD_REQUEST', 'steps array is required', 400);

  try {
    const template = await getServices(env).templates.publishTemplate({
      name: body.name as string,
      description: typeof body.description === 'string' ? body.description : undefined,
      industry: typeof body.industry === 'string' ? body.industry : undefined,
      category: typeof body.category === 'string' ? body.category : undefined,
      steps: body.steps as unknown[],
      tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
    }, ctx.account_id);
    return ok(template, 201);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Internal error';
    if (msg.includes('already exists')) return fail('CONFLICT', msg, 409);
    return fail('BAD_REQUEST', msg, 400);
  }
}));

export default marketplaceRouter;
