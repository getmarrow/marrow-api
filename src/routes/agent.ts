import { Router, type IRequest, type Env, forwardToLegacy } from './shared';

export const agentRouter = Router();

for (const [method, path] of [
  ['POST', '/v1/agent/think'],
  ['GET', '/v1/agent/patterns'],
  ['GET', '/v1/agent/suggestions'],
  ['POST', '/v1/agent/commit'],
  ['POST', '/v1/agent/session/end'],
  ['GET', '/v1/agent/nudge'],
  ['GET', '/v1/agent/status'],
] as const) {
  agentRouter[method.toLowerCase() as 'get' | 'post'](path, (request: IRequest, env: Env) => forwardToLegacy(request, env));
}

export default agentRouter;
