import { Router, type IRequest, type Env, forwardToLegacy } from './shared';

export const decisionsRouter = Router();

const routes = [
  ['POST', '/decisions'],
  ['GET', '/decisions'],
  ['POST', '/v1/decisions'],
  ['GET', '/v1/decisions'],
  ['GET', '/v1/decisions/shared'],
  ['GET', '/v1/decisions/routing-suggestions'],
  ['GET', '/v1/decisions/priority'],
  ['GET', '/v1/decisions/:id'],
  ['PUT', '/v1/decisions/:id/outcome'],
  ['GET', '/v1/decisions/:id/outcome'],
  ['GET', '/v1/decisions/feedback/history'],
  ['GET', '/v1/feedback/metrics'],
  ['POST', '/v1/decisions/:id/share'],
  ['POST', '/v1/decisions/:id/caused-by'],
  ['GET', '/v1/decisions/:id/causality'],
  ['POST', '/v1/decisions/predict'],
  ['POST', '/v1/decisions/:id/prioritize'],
  ['GET', '/v1/queue/status'],
  ['POST', '/v1/decisions/:id/consensus-vote'],
] as const;

for (const [method, path] of routes) {
  decisionsRouter[method.toLowerCase() as 'get' | 'post' | 'put'](path, (request: IRequest, env: Env) => forwardToLegacy(request, env));
}

export default decisionsRouter;
