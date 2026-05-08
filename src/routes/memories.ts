import { Router, type IRequest } from 'itty-router';
import type { ApiKeyScope, ApiResponse, Env, ManagedApiKey, RequestContext } from '../types';
import { AuthRateLimitError, AuthService, AuthServiceError } from '../services/auth.service';
import { MemoryService } from '../services/memory.service';

const MARROW_API_VERSION = '2026.03.29';
const MARROW_SDK_LATEST = '3.7.17';
const MARROW_MCP_LATEST = '3.9.18';

function json<T>(data: T, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Marrow-Version': MARROW_API_VERSION,
      'X-Marrow-SDK-Latest': MARROW_SDK_LATEST,
      'X-Marrow-MCP-Latest': MARROW_MCP_LATEST,
      ...headers,
    },
  });
}

function err(error: string, status = 500, details?: Record<string, string>): Response {
  const codeMap: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR' };
  const body: ApiResponse & { code?: string } = { error, code: codeMap[status] || 'ERROR' };
  if (details) body.details = details;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getUrl(request: IRequest): URL {
  return new URL(request.url);
}

function hasAnyScope(ctx: RequestContext, scopes: ApiKeyScope[]): boolean {
  const granted = ctx.scopes || ['full'];
  return granted.includes('full') || scopes.some((scope) => granted.includes(scope));
}

function getRequiredScopes(path: string, method: string): ApiKeyScope[] | 'full' | null {
  if (path === '/v1/auth/account') return null;
  if (path.startsWith('/v1/auth/keys')) return ['agents:manage'];
  if (path === '/v1/memories/import') return method === 'GET' ? ['memories:read'] : ['memories:import', 'memories:write'];
  if (path === '/v1/memories/export' || path === '/v1/memories/retrieve') return ['memories:read', 'memories:export'];
  if (path.startsWith('/v1/memories')) return method === 'GET' ? ['memories:read'] : ['memories:write'];
  if (path === '/v1/agent/think' || path === '/v1/agent/commit' || path === '/v1/agent/nudge' || path.startsWith('/v1/decisions') || path.startsWith('/decisions')) {
    return method === 'GET' ? ['decisions:read'] : ['decisions:write'];
  }
  if (path.startsWith('/v1/patterns')) return ['patterns:read'];
  if (path.startsWith('/v1/webhooks')) return ['webhooks:manage'];
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return 'full';
  return 'full';
}

function getAccessAgentIds(ctx: RequestContext): string[] | undefined {
  if (ctx.agent_ids && ctx.agent_ids.length > 0) return ctx.agent_ids;
  if (ctx.agent_id) return [ctx.agent_id];
  return undefined;
}

function isAgentBoundContext(ctx: RequestContext): boolean {
  return Boolean(ctx.agent_id) || Boolean(ctx.agent_ids && ctx.agent_ids.length > 0);
}

function isTestKeyContext(ctx: RequestContext): boolean {
  return ctx.api_key_type === 'test';
}

function isTestKeyManagementPath(path: string): boolean {
  return path === '/v1/auth/account'
    || path === '/v1/auth/keys'
    || /^\/v1\/auth\/keys\/[^/]+$/.test(path)
    || /^\/v1\/auth\/keys\/[^/]+\/(revoke|rotate)$/.test(path)
    || path === '/v1/auth/keys/revoke';
}

function ensureTestKeyManagedKeyAccess(ctx: RequestContext, key: ManagedApiKey | null): Response | null {
  if (!isTestKeyContext(ctx)) return null;
  if (!key) return err('Not found', 404);
  if (key.key_type !== 'test') return err('Test keys can only manage test keys.', 403);
  return null;
}

function enforceRoutePolicy(request: IRequest, ctx: RequestContext): Response | null {
  const path = getUrl(request).pathname;
  if (isTestKeyContext(ctx) && !isTestKeyManagementPath(path)) {
    return err('Test keys cannot access production data.', 403);
  }

  const required = getRequiredScopes(path, request.method.toUpperCase());
  if (required === null) return null;
  if (required === 'full') {
    return hasAnyScope(ctx, ['full']) ? null : err('Insufficient scope', 403);
  }
  return hasAnyScope(ctx, required) ? null : err('Insufficient scope', 403);
}

async function requireAuth(request: IRequest, env: Env): Promise<RequestContext | Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    return err('Unauthorized', 401);
  }

  try {
    const authService = new AuthService(env.DB);
    const ctx = await authService.validateToken(authHeader, {
      ip: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
      ctx: env.EXECUTION_CONTEXT,
    });
    if (!ctx) {
      return err('Unauthorized', 401);
    }

    const allowed = await authService.enforceApiRateLimit(ctx.api_key_id, ctx.tier);
    if (!allowed) {
      return err('Rate limit exceeded', 429);
    }

    const policyError = enforceRoutePolicy(request, ctx);
    if (policyError) return policyError;

    return ctx;
  } catch (error) {
    if (error instanceof AuthRateLimitError) return err(error.message, 429);
    if (error instanceof AuthServiceError) return err(error.message, error.status);
    return err('Auth error', 500);
  }
}

function getRequestedAgentIds(request: IRequest, ctx: RequestContext): string[] | undefined {
  const bound = getAccessAgentIds(ctx);
  if (bound && bound.length > 0) return bound;

  const url = getUrl(request);
  const queryAgentIds = [
    ...url.searchParams.getAll('agent_id'),
    ...url.searchParams.getAll('agentId'),
  ].map((value) => value.trim()).filter(Boolean);

  if (queryAgentIds.length > 0) return Array.from(new Set(queryAgentIds));
  return undefined;
}

export const router = Router();

router.get('/v1/memories/retrieve', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const url = getUrl(request);
    const query = (url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
    const service = new MemoryService(env.DB);
    const result = await service.retrieveMemories(ctx.account_id, query, {
      limit: Number(url.searchParams.get('limit') || undefined),
      from: url.searchParams.get('from') || undefined,
      to: url.searchParams.get('to') || undefined,
      tags: url.searchParams.get('tags') || undefined,
      source: url.searchParams.get('source') || undefined,
      status: (url.searchParams.get('status') || undefined) as 'active' | 'outdated' | 'superseded' | 'deleted' | undefined,
      shared: url.searchParams.get('shared') === 'true',
      agentIds: getRequestedAgentIds(request, ctx),
    });
    return json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('GET /v1/memories/retrieve error:', msg);
    return err('Internal server error', 500);
  }
});

router.get('/v1/memories/export', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const url = getUrl(request);
    const service = new MemoryService(env.DB);
    const result = await service.exportMemories(ctx.account_id, {
      format: (url.searchParams.get('format') || 'json') as 'json' | 'csv',
      status: (url.searchParams.get('status') || undefined) as 'active' | 'outdated' | 'superseded' | 'deleted' | 'all' | undefined,
      tags: (url.searchParams.get('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean),
      agentIds: getRequestedAgentIds(request, ctx),
    });
    return json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('GET /v1/memories/export error:', msg);
    return err('Internal server error', 500);
  }
});

router.post('/v1/memories/import', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    if (isAgentBoundContext(ctx)) return err('Agent-bound tokens cannot import memories.', 403);

    const body = await request.json() as { memories?: Array<{ text?: string; source?: string; tags?: string[]; sharedWith?: string[] }>; mode?: 'merge' | 'replace' };
    const service = new MemoryService(env.DB);
    const result = await service.importMemories(
      ctx.account_id,
      Array.isArray(body.memories) ? body.memories : [],
      body.mode === 'replace' ? 'replace' : 'merge',
    );
    return json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg.includes('Import validation failed') || msg.includes('missing memory text')) {
      return err(msg, 400);
    }
    console.error('POST /v1/memories/import error:', msg);
    return err('Internal server error', 500);
  }
});

router.get('/v1/memories', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const url = getUrl(request);
    const service = new MemoryService(env.DB);
    const memories = await service.listMemories(ctx.account_id, {
      status: (url.searchParams.get('status') || undefined) as 'active' | 'outdated' | 'superseded' | 'deleted' | undefined,
      query: url.searchParams.get('query') || url.searchParams.get('q') || undefined,
      limit: Number(url.searchParams.get('limit') || undefined),
      agentIds: getRequestedAgentIds(request, ctx),
    });
    return json({ memories, count: memories.length });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('GET /v1/memories error:', msg);
    return err('Internal server error', 500);
  }
});

router.get('/v1/memories/:id', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const id = String(request.params?.id || '');
    const service = new MemoryService(env.DB);
    const memory = await service.getMemory(id, ctx.account_id, { accessAgentIds: getAccessAgentIds(ctx) });
    if (!memory) return err('Memory not found', 404, { id });
    return json(memory);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('GET /v1/memories/:id error:', msg);
    return err('Internal server error', 500);
  }
});

router.patch('/v1/memories/:id', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const id = String(request.params?.id || '');
    const body = await request.json() as { text?: string; source?: string | null; tags?: string[]; actor?: string; note?: string };
    const service = new MemoryService(env.DB);
    const memory = await service.updateMemory(id, ctx.account_id, body, { accessAgentIds: getAccessAgentIds(ctx) });
    if (!memory) return err('Memory not found', 404, { id });
    return json(memory);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg.includes('Memory text is required')) return err(msg, 400);
    console.error('PATCH /v1/memories/:id error:', msg);
    return err('Internal server error', 500);
  }
});

router.delete('/v1/memories/:id', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const id = String(request.params?.id || '');
    const body = request.headers.get('content-type')?.includes('application/json')
      ? await request.json() as { actor?: string; note?: string }
      : {};
    const service = new MemoryService(env.DB);
    const memory = await service.deleteMemory(id, ctx.account_id, body, { accessAgentIds: getAccessAgentIds(ctx) });
    if (!memory) return err('Memory not found', 404, { id });
    return json(memory);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('DELETE /v1/memories/:id error:', msg);
    return err('Internal server error', 500);
  }
});

router.post('/v1/memories/:id/outdated', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const id = String(request.params?.id || '');
    const body = await request.json() as { actor?: string; note?: string };
    const service = new MemoryService(env.DB);
    const memory = await service.markOutdated(id, ctx.account_id, body, { accessAgentIds: getAccessAgentIds(ctx) });
    if (!memory) return err('Memory not found', 404, { id });
    return json(memory);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('POST /v1/memories/:id/outdated error:', msg);
    return err('Internal server error', 500);
  }
});

router.post('/v1/memories/:id/supersede', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const id = String(request.params?.id || '');
    const body = await request.json() as { text?: string; source?: string; tags?: string[]; actor?: string; note?: string };
    const service = new MemoryService(env.DB);
    const result = await service.supersedeMemory(id, ctx.account_id, {
      text: String(body.text || ''),
      source: body.source,
      tags: body.tags,
      actor: body.actor,
      note: body.note,
    }, { accessAgentIds: getAccessAgentIds(ctx) });
    if (!result) return err('Memory not found', 404, { id });
    return json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg.includes('Replacement memory text is required')) return err(msg, 400);
    console.error('POST /v1/memories/:id/supersede error:', msg);
    return err('Internal server error', 500);
  }
});

router.post('/v1/memories/:id/share', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    if (isAgentBoundContext(ctx)) return err('Agent-bound tokens cannot share memories.', 403);

    const id = String(request.params?.id || '');
    const body = await request.json() as { agent_ids?: string[]; agentIds?: string[]; actor?: string };
    const service = new MemoryService(env.DB);
    const memory = await service.shareMemory(
      id,
      ctx.account_id,
      Array.isArray(body.agent_ids) ? body.agent_ids : (Array.isArray(body.agentIds) ? body.agentIds : []),
      body.actor,
      { accessAgentIds: getAccessAgentIds(ctx) },
    );
    if (!memory) return err('Memory not found', 404, { id });
    return json(memory);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('POST /v1/memories/:id/share error:', msg);
    return err('Internal server error', 500);
  }
});
