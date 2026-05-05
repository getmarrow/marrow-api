import { Router, type IRequest, type Env, forwardToLegacy } from './shared';

export const patternsRouter = Router();

for (const [method, path] of [
  ['GET', '/v1/patterns'],
  ['GET', '/v1/patterns/:id'],
  ['POST', '/v1/patterns/:id/validate'],
  ['GET', '/v1/trends'],
  ['GET', '/v1/hive'],
  ['GET', '/v1/hive/signals'],
  ['GET', '/v1/templates/learned'],
  ['GET', '/v1/org/patterns'],
  ['GET', '/v1/bootstrap'],
  ['GET', '/v1/bootstrap/categories'],
  ['POST', '/v1/bootstrap/:id/apply'],
  ['POST', '/v1/bootstrap'],
  ['GET', '/v1/audit'],
  ['GET', '/v1/audit/verify'],
  ['GET', '/v1/consensus/metrics'],
  ['GET', '/v1/safety/violations'],
  ['POST', '/v1/safety/check'],
  ['GET', '/v1/stream'],
] as const) {
  patternsRouter[method.toLowerCase() as 'get' | 'post'](path, (request: IRequest, env: Env) => forwardToLegacy(request, env));
}

export default patternsRouter;
