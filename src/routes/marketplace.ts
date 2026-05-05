import { Router, type IRequest, type Env, forwardToLegacy } from './shared';

export const marketplaceRouter = Router();

for (const [method, path] of [
  ['POST', '/v1/lessons'],
  ['POST', '/v1/lessons/:id/publish'],
  ['GET', '/v1/lessons/marketplace'],
  ['POST', '/v1/lessons/:id/fork'],
  ['POST', '/v1/lessons/:id/rate'],
  ['GET', '/v1/lessons/:id/versions'],
  ['GET', '/v1/templates'],
  ['GET', '/v1/templates/:slug'],
  ['POST', '/v1/templates/:slug/install'],
  ['POST', '/v1/templates'],
] as const) {
  marketplaceRouter[method.toLowerCase() as 'get' | 'post'](path, (request: IRequest, env: Env) => forwardToLegacy(request, env));
}

export default marketplaceRouter;
