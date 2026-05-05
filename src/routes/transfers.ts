import { Router, type IRequest, type Env, forwardToLegacy } from './shared';

export const transfersRouter = Router();

for (const [method, path] of [
  ['GET', '/v1/lessons/transfer'],
  ['POST', '/v1/lessons/:id/transfer-to'],
  ['GET', '/v1/transfer-metrics'],
] as const) {
  transfersRouter[method.toLowerCase() as 'get' | 'post'](path, (request: IRequest, env: Env) => forwardToLegacy(request, env));
}

export default transfersRouter;
