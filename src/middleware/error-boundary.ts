/**
 * Global error boundary middleware.
 *
 * Wraps every route handler with try/catch. On error:
 *  - Logs method, path, and message to stderr
 *  - Returns standardized 500 JSON response
 *  - Injects CORS headers on every response
 *
 * Usage:
 *   import { withErrorBoundary } from '../middleware/error-boundary';
 *   router.get('/v1/decisions', withErrorBoundary(myHandler));
 */

import type { IRequest } from 'itty-router';
import type { Env } from '../types';

type RouteHandler = (request: IRequest, env: Env, ...rest: unknown[]) => Response | Promise<Response>;

function getCorsHeaders(_request: IRequest): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Marrow-Session-Id, X-Marrow-Agent-Id, X-Session-Id',
  };
}

export function withErrorBoundary(handler: RouteHandler): RouteHandler {
  return async (request: IRequest, env: Env, ...rest: unknown[]): Promise<Response> => {
    try {
      const response = await handler(request, env, ...rest);
      // Inject CORS headers on every response from this handler
      const corsHeaders = getCorsHeaders(request);
      for (const [key, value] of Object.entries(corsHeaders)) {
        if (!response.headers.has(key)) {
          response.headers.set(key, value);
        }
      }
      return response;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const url = new URL(request.url);
      console.error(`[${request.method} ${url.pathname}] ${message}`, error);
      return new Response(
        JSON.stringify({ error: 'Internal error', code: 'INTERNAL_ERROR' }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders(request),
          },
        },
      );
    }
  };
}
