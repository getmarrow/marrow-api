import { Router, type IRequest } from 'itty-router';
import type { Env, RequestContext } from '../types';
import { getServices } from '../lib/services';
import { ok, fail } from '../lib/response';
import { withAuth } from '../middleware/auth';
import { withErrorBoundary } from '../middleware/error-boundary';
import { checkRateLimit } from '../utils/rate-limit';

function getUrl(request: IRequest): URL {
  return new URL(request.url);
}

function authRoute(handler: (request: IRequest, env: Env, ctx: RequestContext) => Promise<Response>): (request: IRequest, env: Env) => Promise<Response> {
  return withErrorBoundary(withAuth(async (request: IRequest, env: Env) => handler(request, env, request.ctx as RequestContext)));
}

export const router = Router();

router.post('/v1/webhooks', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  if (ctx.tier === 'free') return fail('FORBIDDEN', 'Webhooks require Pro or Enterprise tier', 403);

  const body = await request.json() as { url?: string; secret?: string; decision_types?: string[] };
  if (!body.url || !body.secret) return fail('BAD_REQUEST', 'url and secret required', 400);

  try {
    const hook = await getServices(env).webhook.create(ctx.account_id, body.url, body.secret, body.decision_types);
    return ok(hook);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Internal error';
    if (msg.includes('not allowed') || msg.includes('max 500')) return fail('BAD_REQUEST', msg, 400);
    return fail('INTERNAL_ERROR', 'Internal error', 500);
  }
}));

router.get('/v1/webhooks', authRoute(async (_request: IRequest, env: Env, ctx: RequestContext) => {
  if (ctx.tier === 'free') return fail('FORBIDDEN', 'Webhooks require Pro or Enterprise tier', 403);

  const hooks = await getServices(env).webhook.list(ctx.account_id);
  const safe = hooks.map((hook) => ({
    ...hook,
    secret: undefined,
    secret_hint: hook.secret ? (hook.secret.length >= 8 ? `****${hook.secret.slice(-4)}` : '****') : null,
  }));
  return ok(safe);
}));

router.delete('/v1/webhooks/:id', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const deleted = await getServices(env).webhook.delete(String(request.params?.id), ctx.account_id);
  if (!deleted) return fail('NOT_FOUND', 'Not found', 404);
  return ok({ deleted: true });
}));

router.post('/v1/org', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  if (ctx.tier !== 'enterprise' && ctx.tier !== 'owner') return fail('FORBIDDEN', 'Org management requires Enterprise tier', 403);

  const body = await request.json() as { name?: string };
  if (!body.name) return fail('BAD_REQUEST', 'name required', 400);
  if (body.name.length > 100) return fail('BAD_REQUEST', 'Org name max 100 characters', 400);

  const org = await getServices(env).org.createOrg(body.name, ctx.account_id);
  return ok(org);
}));

router.post('/v1/org/invite', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  if (ctx.tier !== 'enterprise' && ctx.tier !== 'owner') return fail('FORBIDDEN', 'Org management requires Enterprise tier', 403);

  const body = await request.json() as { account_id?: string; role?: string };
  if (!body.account_id) return fail('BAD_REQUEST', 'account_id required', 400);

  const role = body.role || 'member';
  if (role !== 'admin' && role !== 'member') return fail('BAD_REQUEST', 'role must be admin or member', 400);

  const orgSvc = getServices(env).org;
  const org = await orgSvc.getOrgForAccount(ctx.account_id);
  if (!org) return fail('NOT_FOUND', 'No org found for your account', 404);

  const callerRole = await env.DB
    .prepare('SELECT role FROM org_members WHERE org_id = ? AND account_id = ? LIMIT 1')
    .bind(org.id, ctx.account_id)
    .first<{ role: string }>();
  if (!callerRole || (callerRole.role !== 'owner' && callerRole.role !== 'admin')) {
    return fail('FORBIDDEN', 'Only org owners and admins can invite members', 403);
  }

  try {
    const member = await orgSvc.addMember(org.id, body.account_id, role === 'admin' ? 'admin' : 'viewer');
    return ok(member);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Internal error';
    return fail('BAD_REQUEST', msg, 400);
  }
}));

router.put('/v1/org/settings', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  if (ctx.tier !== 'enterprise' && ctx.tier !== 'owner') return fail('FORBIDDEN', 'Org management requires Enterprise tier', 403);

  const body = await request.json() as { pii_strip_team?: boolean };
  const orgSvc = getServices(env).org;
  const org = await orgSvc.getOrgForAccount(ctx.account_id);
  if (!org) return fail('NOT_FOUND', 'No org found for your account', 404);

  if (body.pii_strip_team !== undefined) {
    await orgSvc.updatePiiStripTeam(org.id, body.pii_strip_team);
  }

  const updated = await orgSvc.getOrgForAccount(ctx.account_id);
  return ok(updated);
}));

router.get('/v1/org/members', authRoute(async (_request: IRequest, env: Env, ctx: RequestContext) => {
  if (ctx.tier !== 'enterprise' && ctx.tier !== 'owner') return fail('FORBIDDEN', 'Org management requires Enterprise tier', 403);

  const org = await getServices(env).org.getOrgForAccount(ctx.account_id);
  if (!org) return fail('NOT_FOUND', 'No org found', 404);

  const members = await getServices(env).org.listMembers(org.id);
  return ok(members);
}));

router.post('/v1/agents', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const allowed = await checkRateLimit(env.DB, `agents_create:${ctx.account_id}`, 10, 60 * 1000);
  if (!allowed) return fail('RATE_LIMITED', 'Rate limited', 429);

  const body = await request.json?.() as Record<string, unknown> | undefined;
  if (!body?.name || typeof body.name !== 'string') return fail('BAD_REQUEST', 'name is required', 400);

  try {
    const agent = await getServices(env).fleet.registerAgent(ctx.account_id, {
      name: body.name as string,
      role: typeof body.role === 'string' ? body.role : undefined,
      specialty: typeof body.specialty === 'string' ? body.specialty : undefined,
      avatar_url: typeof body.avatar_url === 'string' ? body.avatar_url : undefined,
    });
    return ok(agent, 201);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg.includes('UNIQUE')) return fail('CONFLICT', 'Agent name already exists in this account', 409);
    return fail('BAD_REQUEST', msg, 400);
  }
}));

router.get('/v1/agents', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const agents = await getServices(env).fleet.listAgents(ctx.account_id, {
    status: url.searchParams.get('status') || 'active',
    limit: parseInt(url.searchParams.get('limit') || '50') || 50,
  });
  return ok({ agents });
}));

router.get('/v1/agents/:id', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const agentId = String(request.params?.id || '');
  if (!agentId) return fail('BAD_REQUEST', 'Agent ID required', 400);

  const agentSvc = getServices(env).fleet;
  const agent = await agentSvc.getAgent(agentId, ctx.account_id);
  if (!agent) return fail('NOT_FOUND', 'Agent not found', 404);

  const stats = await agentSvc.getAgentStats(agentId, ctx.account_id);
  return ok({ ...agent, stats });
}));

router.patch('/v1/agents/:id', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const agentId = String(request.params?.id || '');
  if (!agentId) return fail('BAD_REQUEST', 'Agent ID required', 400);

  const body = await request.json?.() as Record<string, unknown> | undefined;
  if (!body) return fail('BAD_REQUEST', 'Request body required', 400);

  try {
    const updated = await getServices(env).fleet.updateAgent(agentId, ctx.account_id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      role: typeof body.role === 'string' ? body.role : undefined,
      specialty: typeof body.specialty === 'string' ? body.specialty : undefined,
      status: typeof body.status === 'string' ? body.status : undefined,
      avatar_url: typeof body.avatar_url === 'string' ? body.avatar_url : undefined,
    });
    if (!updated) return fail('NOT_FOUND', 'Agent not found', 404);
    return ok(updated);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return fail('BAD_REQUEST', msg, 400);
  }
}));

router.delete('/v1/agents/:id', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const agentId = String(request.params?.id || '');
  if (!agentId) return fail('BAD_REQUEST', 'Agent ID required', 400);

  const archived = await getServices(env).fleet.archiveAgent(agentId, ctx.account_id);
  if (!archived) return fail('NOT_FOUND', 'Agent not found or already archived', 404);
  return ok({ archived: true });
}));

router.post('/v1/orgs', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const allowed = await checkRateLimit(env.DB, `orgs_create:${ctx.account_id}`, 5, 60 * 1000);
  if (!allowed) return fail('RATE_LIMITED', 'Rate limited', 429);

  const body = await request.json?.() as Record<string, unknown> | undefined;
  if (!body?.name || typeof body.name !== 'string') return fail('BAD_REQUEST', 'name is required', 400);

  try {
    const org = await getServices(env).org.createOrg(
      body.name as string,
      ctx.account_id,
      typeof body.industry === 'string' ? body.industry : undefined,
    );
    return ok({ id: org.id, name: org.name, slug: org.slug }, 201);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return fail('BAD_REQUEST', msg, 400);
  }
}));

router.get('/v1/orgs/:id', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const orgId = String(request.params?.id || '');
  const orgSvc = getServices(env).org;
  const isMember = await orgSvc.isOrgMember(orgId, ctx.account_id);
  if (!isMember) return fail('FORBIDDEN', 'Not a member of this organization', 403);

  const result = await orgSvc.getOrgWithMembers(orgId);
  if (!result) return fail('NOT_FOUND', 'Organization not found', 404);
  return ok(result);
}));

router.post('/v1/orgs/:id/members', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const orgId = String(request.params?.id || '');
  const orgSvc = getServices(env).org;
  const hasRole = await orgSvc.hasMinRole(orgId, ctx.account_id, 'admin');
  if (!hasRole) return fail('FORBIDDEN', 'Admin or owner role required to invite members', 403);

  const body = await request.json?.() as Record<string, unknown> | undefined;
  if (!body?.account_id || typeof body.account_id !== 'string') return fail('BAD_REQUEST', 'account_id is required', 400);

  try {
    const role = (typeof body.role === 'string' ? body.role : 'viewer') as 'admin' | 'operator' | 'viewer';
    const member = await orgSvc.addMember(orgId, body.account_id as string, role);
    return ok(member, 201);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return fail('BAD_REQUEST', msg, 400);
  }
}));

router.delete('/v1/orgs/:id/members/:memberId', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const orgId = String(request.params?.id || '');
  const memberId = String(request.params?.memberId || '');
  const orgSvc = getServices(env).org;
  const hasRole = await orgSvc.hasMinRole(orgId, ctx.account_id, 'admin');
  if (!hasRole) return fail('FORBIDDEN', 'Admin or owner role required', 403);

  try {
    const removed = await orgSvc.removeMember(orgId, memberId);
    if (!removed) return fail('NOT_FOUND', 'Member not found', 404);
    return ok({ removed: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return fail('BAD_REQUEST', msg, 400);
  }
}));

router.patch('/v1/orgs/:id/members/:memberId', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const orgId = String(request.params?.id || '');
  const memberId = String(request.params?.memberId || '');
  const orgSvc = getServices(env).org;
  const hasRole = await orgSvc.hasMinRole(orgId, ctx.account_id, 'owner');
  if (!hasRole) return fail('FORBIDDEN', 'Owner role required to change member roles', 403);

  const body = await request.json?.() as Record<string, unknown> | undefined;
  if (!body?.role || typeof body.role !== 'string') return fail('BAD_REQUEST', 'role is required', 400);

  try {
    const updated = await orgSvc.updateMemberRole(orgId, memberId, body.role as 'admin' | 'operator' | 'viewer');
    if (!updated) return fail('NOT_FOUND', 'Member not found', 404);
    return ok({ updated: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return fail('BAD_REQUEST', msg, 400);
  }
}));

router.get('/v1/fleet', authRoute(async (_request: IRequest, env: Env, ctx: RequestContext) => {
  const allowed = await checkRateLimit(env.DB, `fleet:${ctx.account_id}`, 60, 60 * 1000);
  if (!allowed) return fail('RATE_LIMITED', 'Rate limited', 429);

  const status = await getServices(env).fleet.getFleetStatus(ctx.account_id);
  return ok(status);
}));

router.get('/v1/fleet/stream', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const allowed = await checkRateLimit(env.DB, `fleet_stream:${ctx.account_id}`, 120, 60 * 1000);
  if (!allowed) return fail('RATE_LIMITED', 'Rate limited', 429);

  const url = getUrl(request);
  const since = url.searchParams.get('since') || new Date(Date.now() - 60000).toISOString();
  const events = await getServices(env).fleet.getFleetEvents(ctx.account_id, since);

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}));

// ============= Org Patterns (cross-agent team patterns, Phase 3) =============

router.get('/v1/org/patterns', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  if (ctx.tier !== 'enterprise' && ctx.tier !== 'owner') {
    return fail('FORBIDDEN', 'Team patterns require Enterprise tier', 403);
  }

  const orgSvc = getServices(env).org;
  const org = await orgSvc.getOrgForAccount(ctx.account_id);
  if (!org) return fail('NOT_FOUND', 'No organization found for this account', 404);

  const url = getUrl(request);
  const decisionType = url.searchParams.get('decision_type') || 'all';
  const patterns = getServices(env).patterns;
  const result = await patterns.discoverOrgPatterns(org.id, decisionType);

  return ok({ org_id: org.id, org_name: org.name, patterns: result });
}));

export default router;
