import { Router, type IRequest, type Env, forwardToLegacy } from './shared';

export const memoryRouter = Router();

for (const [method, path] of [
  ['GET', '/v1/memories/retrieve'],
  ['GET', '/v1/memories/export'],
  ['POST', '/v1/memories/import'],
  ['GET', '/v1/memories'],
  ['GET', '/v1/memories/:id'],
  ['PATCH', '/v1/memories/:id'],
  ['DELETE', '/v1/memories/:id'],
  ['POST', '/v1/memories/:id/outdated'],
  ['POST', '/v1/memories/:id/supersede'],
  ['POST', '/v1/memories/:id/share'],
] as const) {
  memoryRouter[method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'](path, (request: IRequest, env: Env) => forwardToLegacy(request, env));
}

export default memoryRouter;
