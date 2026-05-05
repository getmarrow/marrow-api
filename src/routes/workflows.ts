import { Router, type IRequest, type Env, forwardToLegacy } from './shared';

export const workflowsRouter = Router();

for (const [method, path] of [
  ['POST', '/v1/workflow/before'],
  ['POST', '/v1/workflow/after'],
  ['GET', '/v1/workflow/status'],
  ['POST', '/v1/workflows/register'],
  ['GET', '/v1/workflows'],
  ['GET', '/v1/workflows/:workflowId'],
  ['PUT', '/v1/workflows/:workflowId'],
  ['POST', '/v1/workflows/:workflowId/start'],
  ['PUT', '/v1/workflows/:workflowId/instances/:instanceId/step'],
  ['GET', '/v1/workflows/:workflowId/instances'],
  ['POST', '/v1/workflows/accept-detected'],
  ['POST', '/v1/webhooks'],
  ['GET', '/v1/webhooks'],
  ['DELETE', '/v1/webhooks/:id'],
] as const) {
  workflowsRouter[method.toLowerCase() as 'get' | 'post' | 'put' | 'delete'](path, (request: IRequest, env: Env) => forwardToLegacy(request, env));
}

export default workflowsRouter;
