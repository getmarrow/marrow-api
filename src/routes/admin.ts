import { Router, type IRequest, type Env, forwardToLegacy } from './shared';

export const adminRouter = Router();

for (const [method, path] of [
  ['PUT', '/v1/admin/accounts/:accountId/tier'],
  ['POST', '/v1/admin/auth'],
  ['GET', '/v1/admin/stats'],
  ['GET', '/v1/admin/trajectory'],
] as const) {
  adminRouter[method.toLowerCase() as 'get' | 'post' | 'put'](path, (request: IRequest, env: Env) => forwardToLegacy(request, env));
}

export default adminRouter;
