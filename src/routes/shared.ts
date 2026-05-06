import { Router, type IRequest } from 'itty-router';
import type { Env, RequestContext, ApiResponse, ApiKeyScope, ManagedApiKey } from '../types';
import { AuthRateLimitError, AuthService, AuthServiceError } from '../services/auth.service';
import { autoLogDecision } from '../middleware/auto-logger';
import { checkRateLimit } from '../utils/rate-limit';
import { safely, safelyAsync } from '../utils/safely';
import { enforceRoutePolicy, isTestKeyContext } from '../middleware/policy';
import type { VelocityMetric } from '../services/velocity.service';
import type { ImprovementResult } from '../services/baseline.service';

export { Router, autoLogDecision, checkRateLimit, safely, safelyAsync };
export type { Env, VelocityMetric, ImprovementResult };

const MARROW_API_VERSION = '2026.03.29';
const MARROW_SDK_LATEST = '3.0.4';
const MARROW_MCP_LATEST = '3.0.7';

export function json<T>(data: T, status = 200, headers?: Record<string, string>): Response {
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

export function err(error: string, status = 500, details?: Record<string, string>): Response {
  const codeMap: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR' };
  const body: ApiResponse & { code?: string } = { error, code: codeMap[status] || 'ERROR' };
  if (details) body.details = details;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function getUrl(request: IRequest): URL {
  return new URL(request.url);
}

export function hasAnyScope(ctx: RequestContext, scopes: ApiKeyScope[]): boolean {
  const granted = ctx.scopes || ['full'];
  return granted.includes('full') || scopes.some((scope) => granted.includes(scope));
}

export function ensureTestKeyManagedKeyAccess(ctx: RequestContext, key: ManagedApiKey | null): Response | null {
  if (!isTestKeyContext(ctx)) return null;
  if (!key) return err('Not found', 404);
  if (key.key_type !== 'test') return err('Test keys can only manage test keys.', 403);
  return null;
}

export function filterKeysForContext(ctx: RequestContext, keys: ManagedApiKey[]): ManagedApiKey[] {
  return isTestKeyContext(ctx) ? keys.filter((key) => key.key_type === 'test') : keys;
}

export async function requireAuth(request: IRequest, env: Env): Promise<RequestContext | Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return err('Unauthorized', 401);

  try {
    const authService = new AuthService(env.DB);
    const ctx = await authService.validateToken(authHeader, {
      ip: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
      ctx: env.EXECUTION_CONTEXT,
    });
    if (!ctx) return err('Unauthorized', 401);

    const allowed = await authService.enforceApiRateLimit(ctx.api_key_id, ctx.tier);
    if (!allowed) return err('Rate limit exceeded', 429);

    const policyError = enforceRoutePolicy(request, ctx);
    if (policyError) return policyError;
    return ctx;
  } catch (error) {
    if (error instanceof AuthRateLimitError) return err(error.message, 429);
    if (error instanceof AuthServiceError) return err(error.message, error.status);
    return err('Auth error', 500);
  }
}

/**
 * Legacy fallback used only by old stub route files that are not mounted anymore.
 * Keep it compile-safe and explicit instead of importing dead modules.
 */
export async function forwardToLegacy(_request: IRequest, _env: Env): Promise<Response> {
  return err('Route not found', 404);
}
