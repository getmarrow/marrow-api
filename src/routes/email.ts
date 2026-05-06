import { Router, type IRequest } from 'itty-router';
import type { Env } from '../types';
import { getServices } from '../lib/services';
import { withErrorBoundary } from '../middleware/error-boundary';

function getUrl(request: IRequest): URL {
  return new URL(request.url);
}

export const router = Router();

router.get('/v1/email/unsubscribe', withErrorBoundary(async (request: IRequest, env: Env) => {
  const token = getUrl(request).searchParams.get('token') || '';
  if (!token) {
    return new Response('<!doctype html><html><body><h1>Not found</h1></body></html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const unsubscribed = await getServices(env).email.unsubscribe(token);
  if (!unsubscribed) {
    return new Response('<!doctype html><html><body><h1>Not found</h1></body></html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  return new Response(`<!doctype html><html><body><p>You've been unsubscribed. Reply to buu@getmarrow.ai if you change your mind.</p></body></html>`, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}));

export default router;
