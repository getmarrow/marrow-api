import { Router, type IRequest, type Env, forwardToLegacy } from './shared';

export const fleetRouter = Router();

for (const [method, path] of [
  ['POST', '/v1/agents'],
  ['GET', '/v1/agents'],
  ['GET', '/v1/agents/:id'],
  ['PATCH', '/v1/agents/:id'],
  ['DELETE', '/v1/agents/:id'],
  ['POST', '/v1/org'],
  ['POST', '/v1/org/invite'],
  ['PUT', '/v1/org/settings'],
  ['GET', '/v1/org/members'],
  ['POST', '/v1/orgs'],
  ['GET', '/v1/orgs/:id'],
  ['POST', '/v1/orgs/:id/members'],
  ['DELETE', '/v1/orgs/:id/members/:memberId'],
  ['PATCH', '/v1/orgs/:id/members/:memberId'],
  ['GET', '/v1/fleet'],
  ['GET', '/v1/fleet/stream'],
] as const) {
  fleetRouter[method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete'](path, (request: IRequest, env: Env) => forwardToLegacy(request, env));
}

export default fleetRouter;
