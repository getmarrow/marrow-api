/**
 * Route Wrapper — eliminates 118 duplicate auth+logging preambles.
 * Every route gets: auth, auto-log, error handling, and service context.
 */
import type { IRequest } from 'itty-router';
import type { Env, RequestContext, ApiKeyScope } from '../types';
import { AuthService } from '../services/auth.service';
import { ServiceContext } from '../services/context';
import { autoLogDecision } from './auto-logger';
import { safely } from '../utils/safely';

export type RouteHandler = (request: IRequest, env: Env, svc: ServiceContext, ctx: RequestContext) => Promise<Response>;

function err(error: string, status = 500, details?: Record<string, string>): Response {
  const codeMap: Record<number, string> = {
    400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN',
    404: 'NOT_FOUND', 429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR',
  };
  const body: Record<string, unknown> = { error, code: codeMap[status] || 'ERROR' };
  if (details) body.details = details;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Wrap a route handler with auth, auto-logging, error handling, and service context.
 * Replaces 84 copies of:
 *   const authResult = await requireAuth(request, env);
 *   if (authResult instanceof Response) return authResult;
 *   const ctx = authResult as RequestContext;
 *   autoLogDecision({...}).catch(() => {});
 */
export function wrap(handler: RouteHandler) {
  return async (request: IRequest, env: Env): Promise<Response> => {
    // Auth
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return err('Unauthorized', 401);

    try {
      const authService = new AuthService(env.DB);
      const ctx = await authService.validateToken(authHeader, {
        requireApiKey: true,
        bypassOtpForDashboard: false,
        allowedScopes: ['decisions:read', 'decisions:write'],
      }) as RequestContext;

      // Service context (lazy-init per request)
      const svc = new ServiceContext(env.DB, env.AI, env);

      // Fire-and-forget auto-log
      safely(() => {
        autoLogDecision({
          db: env.DB,
          accountId: ctx.account_id,
          method: request.method,
          endpoint: new URL(request.url).pathname || request.url,
          statusCode: 200,
          tier: ctx.tier,
        });
      }, 'auto-log');

      return handler(request, env, svc, ctx);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      safely(() => console.error('route error:', msg), 'route-error');
      return err('Internal server error', 500);
    }
  };
}
