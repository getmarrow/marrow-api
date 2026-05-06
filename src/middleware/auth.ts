/**
 * Auth middleware — validates token, enforces rate limit, attaches RequestContext.
 *
 * Usage:
 *   import { withAuth } from '../middleware/auth';
 *   router.get('/v1/decisions', withAuth(myHandler));
 */

import type { IRequest } from 'itty-router';
import type { Env, RequestContext } from '../types';
import { getServices } from '../lib/services';
import { AuthRateLimitError, AuthServiceError } from '../services/auth.service';
import { fail } from '../lib/response';
import { enforceRoutePolicy } from './policy';

type RouteHandler = (request: IRequest, env: Env, ...rest: unknown[]) => Response | Promise<Response>;

export function withAuth(handler: RouteHandler): RouteHandler {
  return async (request: IRequest, env: Env, ...rest: unknown[]): Promise<Response> => {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return fail('UNAUTHORIZED', 'Missing Authorization header', 401);
    }

    try {
      const svc = getServices(env);
      const ctx = await svc.auth.validateToken(authHeader, {
        ip: request.headers.get('cf-connecting-ip'),
        userAgent: request.headers.get('user-agent'),
        ctx: env.EXECUTION_CONTEXT,
      });
      if (!ctx) {
        return fail('UNAUTHORIZED', 'Invalid or expired token', 401);
      }

      const allowed = await svc.auth.enforceApiRateLimit(ctx.api_key_id, ctx.tier);
      if (!allowed) {
        return fail('RATE_LIMITED', 'Rate limit exceeded', 429);
      }

      const policyError = enforceRoutePolicy(request, ctx);
      if (policyError) return policyError;

      (request as IRequest & { ctx?: RequestContext }).ctx = ctx;
      return handler(request, env, ...rest);
    } catch (error: unknown) {
      if (error instanceof AuthRateLimitError) {
        return fail('RATE_LIMITED', error.message, 429);
      }
      if (error instanceof AuthServiceError) {
        return fail('AUTH_ERROR', error.message, error.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      return fail('AUTH_ERROR', message, 500);
    }
  };
}
