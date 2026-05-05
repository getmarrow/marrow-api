import { Router, type IRequest, type Env, forwardToLegacy } from './shared';

export const emailRouter = Router();

for (const [method, path] of [
  ['GET', '/v1/email/unsubscribe'],
  ['POST', '/v1/internal/trigger-onboarding'],
  ['POST', '/v1/internal/send-checkins'],
  ['POST', '/v1/internal/send-day3-nudge'],
] as const) {
  emailRouter[method.toLowerCase() as 'get' | 'post'](path, (request: IRequest, env: Env) => forwardToLegacy(request, env));
}

export default emailRouter;
