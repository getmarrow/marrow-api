import type { IRequest } from 'itty-router';
import type { Env } from '../http';
import { err } from '../http';
import { legacyRouter } from '../legacy';

export * from '../http';
export * from '../middleware/route-wrapper';
export * from '../services/context';
export * from '../utils/safely';

export async function forwardToLegacy(request: IRequest, env: Env): Promise<Response> {
  const response = await legacyRouter.handle(request as Request, env, env.EXECUTION_CONTEXT);
  return response || err('Route not found', 404);
}
