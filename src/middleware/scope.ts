/**
 * Scope middleware — enforces API key scopes on route handlers.
 *
 * Usage:
 *   import { withScope } from '../middleware/scope';
 *   router.get('/v1/decisions', withAuth, withScope('decisions:read'), handler);
 *   // or chained:
 *   const guarded = withAuth(withScope('decisions:write', handler));
 */

import type { IRequest } from 'itty-router';
import { fail } from '../lib/response';

type RouteHandler = (request: IRequest, env: any, ...rest: unknown[]) => Response | Promise<Response>;

export function withScope(...scopes: string[]): (handler: RouteHandler) => RouteHandler {
  return (handler: RouteHandler): RouteHandler => {
    return async (request: IRequest, env: any, ...rest: unknown[]): Promise<Response> => {
      const ctx = request.ctx;
      if (!ctx) {
        return fail('UNAUTHORIZED', 'No auth context — use withAuth before withScope', 401);
      }
      const granted = ctx.scopes || ['full'];
      if (granted.includes('full')) {
        return handler(request, env, ...rest);
      }
      const hasScope = scopes.some((scope) => granted.includes(scope));
      if (!hasScope) {
        return fail('FORBIDDEN', 'Insufficient scope', 403);
      }
      return handler(request, env, ...rest);
    };
  };
}
