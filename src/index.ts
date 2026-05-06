/**
 * Marrow API — Complete 20-Tier Platform
 * Cloudflare Workers + D1 + itty-router
 */
import { Router, IRequest } from 'itty-router';
import { Env, RequestContext } from './types';
import { AuthRateLimitError, AuthService, AuthServiceError } from './services/auth.service';
import { DecisionService } from './services/decision.service';
import { EnterpriseService } from './services/enterprise.service';
import { AnalyticsService } from './services/analytics.service';
import { WorkflowService } from './workflow';
import { log } from './utils/logger';
import { RetentionService } from './services/retention.service';
import { WorkflowRegistryService } from './services/workflow-registry.service';
import { TrendsService } from './services/trends.service';
import { SessionService } from './services/session.service';
import { ImpactService } from './services/impact.service';
import { DashboardService } from './services/dashboard.service';
import { CollectiveService } from './services/collective.service';
import { WorkflowDetectionService } from './services/workflow-detection.service';
import { FleetService } from './services/fleet.service';
import { EmailService } from './services/email.service';
import type { VelocityMetric } from './services/velocity.service';
import type { ImprovementResult } from './services/baseline.service';
import { BaselineService } from './services/baseline.service';
import { checkRateLimit } from './utils/rate-limit';
import { autoLogDecision } from './middleware/auto-logger';
import { actionQualityWarning, isStrictQualityMode, validateActionQuality } from './middleware/action-validator';
import { router as authRouter } from './routes/auth';
import { router as collabRouter } from './routes/collab';
import { router as decisionsRouter } from './routes/decisions';
import { router as fleetRouter } from './routes/fleet';
import { router as hiveRouter } from './routes/hive';
import { router as patternsRouter } from './routes/patterns';
import { router as memoriesRouter } from './routes/memories';
import { router as agentRouter } from './routes/agent';
import { adminRouter } from './routes/admin';
import { marketplaceRouter } from './routes/marketplace';

// ============= Helpers =============

const MARROW_API_VERSION = '2026.03.29';
const MARROW_SDK_LATEST = '3.0.4';
const MARROW_MCP_LATEST = '3.0.7';

function escapeHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function json<T>(data: T, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Marrow-Version': MARROW_API_VERSION,
      'X-Marrow-SDK-Latest': MARROW_SDK_LATEST,
      'X-Marrow-MCP-Latest': MARROW_MCP_LATEST,
      ...headers,
    },
  });
}

function err(error: string, status = 500, details?: Record<string, string>): Response {
  const codeMap: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR' };
  const body: ApiResponse & { code?: string } = { error, code: codeMap[status] || 'ERROR' };
  if (details) body.details = details;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getUrl(request: IRequest): URL {
  return new URL(request.url);
}

function actionQualityError(result: Exclude<ReturnType<typeof validateActionQuality>, { valid: true }>): Response {
  return new Response(JSON.stringify({
    error: result.code,
    message: result.message,
    ...(result.hint ? { hint: result.hint } : {}),
  }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function hasAnyScope(ctx: RequestContext, scopes: ApiKeyScope[]): boolean {
  const granted = ctx.scopes || ['full'];
  return granted.includes('full') || scopes.some((scope) => granted.includes(scope));
}

function getRequiredScopes(path: string, method: string): ApiKeyScope[] | 'full' | null {
  if (path === '/v1/auth/account') return null;
  if (path.startsWith('/v1/auth/keys')) return ['agents:manage'];
  if (path === '/v1/memories/import') return method === 'GET' ? ['memories:read'] : ['memories:import', 'memories:write'];
  if (path === '/v1/memories/export' || path === '/v1/memories/retrieve') return ['memories:read', 'memories:export'];
  if (path.startsWith('/v1/memories')) return method === 'GET' ? ['memories:read'] : ['memories:write'];
  if (path === '/v1/agent/think' || path === '/v1/agent/commit' || path === '/v1/agent/nudge' || path.startsWith('/v1/decisions') || path.startsWith('/decisions')) {
    return method === 'GET' ? ['decisions:read'] : ['decisions:write'];
  }
  if (path.startsWith('/v1/patterns')) return ['patterns:read'];
  if (path.startsWith('/v1/webhooks')) return ['webhooks:manage'];
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return 'full';
  return 'full';
}

function getAccessAgentIds(ctx: RequestContext): string[] | undefined {
  if (ctx.agent_ids && ctx.agent_ids.length > 0) return ctx.agent_ids;
  if (ctx.agent_id) return [ctx.agent_id];
  return undefined;
}

function isAgentBoundContext(ctx: RequestContext): boolean {
  return Boolean(ctx.agent_id) || Boolean(ctx.agent_ids && ctx.agent_ids.length > 0);
}

function isTestKeyContext(ctx: RequestContext): boolean {
  return ctx.api_key_type === 'test';
}

function isTestKeyManagementPath(path: string): boolean {
  return path === '/v1/auth/account'
    || path === '/v1/auth/keys'
    || /^\/v1\/auth\/keys\/[^/]+$/.test(path)
    || /^\/v1\/auth\/keys\/[^/]+\/(revoke|rotate)$/.test(path)
    || path === '/v1/auth/keys/revoke';
}

function ensureTestKeyManagedKeyAccess(ctx: RequestContext, key: ManagedApiKey | null): Response | null {
  if (!isTestKeyContext(ctx)) return null;
  if (!key) return err('Not found', 404);
  if (key.key_type !== 'test') return err('Test keys can only manage test keys.', 403);
  return null;
}

function filterKeysForContext(ctx: RequestContext, keys: ManagedApiKey[]): ManagedApiKey[] {
  return isTestKeyContext(ctx) ? keys.filter((key) => key.key_type === 'test') : keys;
}

function enforceRoutePolicy(request: IRequest, ctx: RequestContext): Response | null {
  const path = getUrl(request).pathname;
  if (isTestKeyContext(ctx) && !isTestKeyManagementPath(path)) {
    return err('Test keys cannot access production data.', 403);
  }

  const required = getRequiredScopes(path, request.method.toUpperCase());
  if (required === null) return null;
  if (required === 'full') {
    return hasAnyScope(ctx, ['full']) ? null : err('Insufficient scope', 403);
  }
  return hasAnyScope(ctx, required) ? null : err('Insufficient scope', 403);
}

// ============= Router =============

const router = Router();
router.all('/v1/keys/*', (request: IRequest, env: Env, ctx: ExecutionContext) => authRouter.handle(request as Request, env, ctx));
router.all('/v1/auth/*', (request: IRequest, env: Env, ctx: ExecutionContext) => authRouter.handle(request as Request, env, ctx));
router.all('/v1/decisions/predict', (request: IRequest, env: Env, ctx: ExecutionContext) => patternsRouter.handle(request as Request, env, ctx));
router.all('/v1/decisions/:id/share', (request: IRequest, env: Env, ctx: ExecutionContext) => collabRouter.handle(request as Request, env, ctx));
router.all('/v1/decisions/:id/caused-by', (request: IRequest, env: Env, ctx: ExecutionContext) => collabRouter.handle(request as Request, env, ctx));
router.all('/v1/decisions/:id/causality', (request: IRequest, env: Env, ctx: ExecutionContext) => collabRouter.handle(request as Request, env, ctx));
router.all('/v1/decisions/:id/prioritize', (request: IRequest, env: Env, ctx: ExecutionContext) => hiveRouter.handle(request as Request, env, ctx));
router.all('/v1/patterns*', (request: IRequest, env: Env, ctx: ExecutionContext) => patternsRouter.handle(request as Request, env, ctx));
router.all('/v1/trends*', (request: IRequest, env: Env, ctx: ExecutionContext) => patternsRouter.handle(request as Request, env, ctx));
router.all('/v1/lessons/transfer', (request: IRequest, env: Env, ctx: ExecutionContext) => patternsRouter.handle(request as Request, env, ctx));
router.all('/v1/lessons/:id/transfer-to', (request: IRequest, env: Env, ctx: ExecutionContext) => patternsRouter.handle(request as Request, env, ctx));
router.all('/v1/lessons/*', (request: IRequest, env: Env, ctx: ExecutionContext) => marketplaceRouter.handle(request as Request, env, ctx));
router.all('/v1/templates*', (request: IRequest, env: Env, ctx: ExecutionContext) => marketplaceRouter.handle(request as Request, env, ctx));
router.all('/v1/admin*', (request: IRequest, env: Env, ctx: ExecutionContext) => adminRouter.handle(request as Request, env, ctx));
router.all('/v1/internal/*', (request: IRequest, env: Env, ctx: ExecutionContext) => adminRouter.handle(request as Request, env, ctx));
router.all('/v1/transfer-metrics', (request: IRequest, env: Env, ctx: ExecutionContext) => patternsRouter.handle(request as Request, env, ctx));
router.all('/v1/queue/status', (request: IRequest, env: Env, ctx: ExecutionContext) => hiveRouter.handle(request as Request, env, ctx));
router.all('/v1/hive*', (request: IRequest, env: Env, ctx: ExecutionContext) => hiveRouter.handle(request as Request, env, ctx));
router.all('/v1/bootstrap*', (request: IRequest, env: Env, ctx: ExecutionContext) => hiveRouter.handle(request as Request, env, ctx));
router.all('/v1/audit*', (request: IRequest, env: Env, ctx: ExecutionContext) => hiveRouter.handle(request as Request, env, ctx));
router.all('/v1/consensus*', (request: IRequest, env: Env, ctx: ExecutionContext) => hiveRouter.handle(request as Request, env, ctx));
router.all('/v1/snapshots*', (request: IRequest, env: Env, ctx: ExecutionContext) => hiveRouter.handle(request as Request, env, ctx));
router.all('/v1/restore*', (request: IRequest, env: Env, ctx: ExecutionContext) => hiveRouter.handle(request as Request, env, ctx));
router.all('/v1/versions*', (request: IRequest, env: Env, ctx: ExecutionContext) => hiveRouter.handle(request as Request, env, ctx));
router.all('/v1/webhooks*', (request: IRequest, env: Env, ctx: ExecutionContext) => fleetRouter.handle(request as Request, env, ctx));
router.all('/v1/org', (request: IRequest, env: Env, ctx: ExecutionContext) => fleetRouter.handle(request as Request, env, ctx));
router.all('/v1/org/invite', (request: IRequest, env: Env, ctx: ExecutionContext) => fleetRouter.handle(request as Request, env, ctx));
router.all('/v1/org/settings', (request: IRequest, env: Env, ctx: ExecutionContext) => fleetRouter.handle(request as Request, env, ctx));
router.all('/v1/org/members', (request: IRequest, env: Env, ctx: ExecutionContext) => fleetRouter.handle(request as Request, env, ctx));
router.all('/v1/org/patterns', (request: IRequest, env: Env, ctx: ExecutionContext) => fleetRouter.handle(request as Request, env, ctx));
router.all('/v1/agents*', (request: IRequest, env: Env, ctx: ExecutionContext) => fleetRouter.handle(request as Request, env, ctx));
router.all('/v1/orgs*', (request: IRequest, env: Env, ctx: ExecutionContext) => fleetRouter.handle(request as Request, env, ctx));
router.all('/v1/fleet*', (request: IRequest, env: Env, ctx: ExecutionContext) => fleetRouter.handle(request as Request, env, ctx));
router.all('/decisions*', (request: IRequest, env: Env, ctx: ExecutionContext) => decisionsRouter.handle(request as Request, env, ctx));
router.all('/v1/decisions*', (request: IRequest, env: Env, ctx: ExecutionContext) => decisionsRouter.handle(request as Request, env, ctx));
router.all('/v1/feedback*', (request: IRequest, env: Env, ctx: ExecutionContext) => decisionsRouter.handle(request as Request, env, ctx));
router.all('/v1/memories*', (request: IRequest, env: Env, ctx: ExecutionContext) => memoriesRouter.handle(request as Request, env, ctx));
router.all('/v1/agent/*', (request: IRequest, env: Env, ctx: ExecutionContext) => agentRouter.handle(request as Request, env, ctx));

// ============= Auth Helper =============
async function requireAuth(request: IRequest, env: Env): Promise<RequestContext | Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    return err('Unauthorized', 401);
  }

  try {
    const authService = new AuthService(env.DB);
    const ctx = await authService.validateToken(authHeader, {
      ip: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
      ctx: env.EXECUTION_CONTEXT,
    });
    if (!ctx) {
      return err('Unauthorized', 401);
    }

    const allowed = await authService.enforceApiRateLimit(ctx.api_key_id, ctx.tier);
    if (!allowed) {
      return err('Rate limit exceeded', 429);
    }

    const policyError = enforceRoutePolicy(request, ctx);
    if (policyError) return policyError;

    return ctx;
  } catch (error) {
    if (error instanceof AuthRateLimitError) return err(error.message, 429);
    if (error instanceof AuthServiceError) return err(error.message, error.status);
    return err('Auth error', 500);
  }
}

// ---------- Internal Auth Helper ----------
async function timingSafeSecretMatch(candidate: string, expected: string, label: string): Promise<Response | null> {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(candidate);
  const bBytes = encoder.encode(expected);
  if (aBytes.length !== bBytes.length) return err('Unauthorized', 401, { label });
  const aKey = await crypto.subtle.importKey('raw', aBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bKey = await crypto.subtle.importKey('raw', bBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const msg = encoder.encode(`marrow-${label}`);
  const aHmac = await crypto.subtle.sign('HMAC', aKey, msg);
  const bHmac = await crypto.subtle.sign('HMAC', bKey, msg);
  const aHex = Array.from(new Uint8Array(aHmac)).map(b => b.toString(16).padStart(2, '0')).join('');
  const bHex = Array.from(new Uint8Array(bHmac)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (aHex !== bHex) return err('Unauthorized', 401, { label });
  return null;
}

async function requireInternalKey(request: IRequest, env: Env): Promise<Response | null> {
  const key = request.headers.get('X-Internal-Key');
  if (!env.INTERNAL_KEY || !key) {
    return err('Unauthorized', 401);
  }
  return timingSafeSecretMatch(key, env.INTERNAL_KEY, 'internal');
}

// ---------- Email Helpers ----------
function emailCard(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#111111;border-radius:12px;border:1px solid #222222;overflow:hidden;">
        <tr><td style="padding:32px 32px 24px;">
          <p style="margin:0 0 4px;font-size:18px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">${title}</p>
          ${body}
          <hr style="border:none;border-top:1px solid #222222;margin:24px 0 20px;">
          <p style="margin:0;font-size:13px;color:#444444;">getmarrow.ai</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Marrow <noreply@mail.getmarrow.ai>', to, subject, html }),
    });
    if (!res.ok) { console.error('[Resend error]', await res.text()); return false; }
    return true;
  } catch (e) { console.error('[sendEmail error]', e); return false; }
}

// ---------- CORS ----------
const ALLOWED_ORIGINS = [
  'https://getmarrow.ai',
  'https://www.getmarrow.ai',
  'https://marrow-vercel-simple.vercel.app',
  'https://marrow-landing.pages.dev',
];

function getCorsHeaders(request: IRequest): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

router.options('*', (request: IRequest) => {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request),
  });
});

// ---------- Public Endpoints (no auth) ----------
router.get('/health', () => json({ status: 'ok', timestamp: new Date().toISOString(), version: MARROW_API_VERSION, sdk_latest: { js: MARROW_SDK_LATEST, mcp: MARROW_MCP_LATEST } }));
router.get('/version', () => json({ version: '1.0.0', build: 'marrow-20-tier', tiers: 20 }));
router.get('/v1/email/unsubscribe', async (request: IRequest, env: Env) => {
  try {
    const token = getUrl(request).searchParams.get('token') || '';
    if (!token) {
      return new Response('<!doctype html><html><body><h1>Not found</h1></body></html>', {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const emailService = new EmailService(env.DB, env);
    const ok = await emailService.unsubscribe(token);
    if (!ok) {
      return new Response('<!doctype html><html><body><h1>Not found</h1></body></html>', {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    return new Response(`<!doctype html><html><body><p>You've been unsubscribed. Reply to buu@getmarrow.ai if you change your mind.</p></body></html>`, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (e) {
    console.error('GET /v1/email/unsubscribe error:', e);
    return err('Internal error', 500);
  }
});

// ============= TIER 2: DECISIONS =============

// POST /decisions (with or without /v1 prefix)
// ============= TIER 17: ANALYTICS =============

router.get('/v1/analytics', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    // Auto-log this API call as a decision (non-blocking, fire-and-forget)
    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: request.url.split(new URL(request.url).origin).pop() || request.url,
      statusCode: 200,

      tier: ctx.tier,
    }).catch(() => {});
    if (ctx.tier === 'free') return err('Analytics require Pro or Enterprise tier', 403);

    const analytics = new AnalyticsService(env.DB);
    const [result, healthScore] = await Promise.all([
      analytics.getAgentAnalytics(ctx.account_id),
      analytics.calculateHealthScore(ctx.account_id).catch(() => null),
    ]);
    const response: Record<string, unknown> = { ...result };
    if (healthScore) {
      response.health_score = healthScore;
    }
    return json(response);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/analytics/agent', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    // Auto-log this API call as a decision (non-blocking, fire-and-forget)
    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: request.url.split(new URL(request.url).origin).pop() || request.url,
      statusCode: 200,

      tier: ctx.tier,
    }).catch(() => {});

    const analytics = new AnalyticsService(env.DB);
    const result = await analytics.getAgentAnalytics(ctx.account_id);
    return json(result);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/analytics/system', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    // Auto-log this API call as a decision (non-blocking, fire-and-forget)
    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: request.url.split(new URL(request.url).origin).pop() || request.url,
      statusCode: 200,

      tier: ctx.tier,
    }).catch(() => {});
    const analytics = new AnalyticsService(env.DB);
    const result = await analytics.getSystemAnalytics();
    return json(result);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/analytics/trending', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    // Auto-log this API call as a decision (non-blocking, fire-and-forget)
    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: request.url.split(new URL(request.url).origin).pop() || request.url,
      statusCode: 200,

      tier: ctx.tier,
    }).catch(() => {});
    const url = getUrl(request);
    const analytics = new AnalyticsService(env.DB);
    const result = await analytics.getTrendingTypes(parseInt(url.searchParams.get('limit') || '10'));
    return json(result);
  } catch (e: unknown) { return err('Internal error'); }
});


router.get('/v1/safety/violations', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    // Auto-log this API call as a decision (non-blocking, fire-and-forget)
    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: request.url.split(new URL(request.url).origin).pop() || request.url,
      statusCode: 200,

      tier: ctx.tier,
    }).catch(() => {});
    const url = getUrl(request);
    const enterprise = new EnterpriseService(env.DB, env.ENCRYPTION_KEY);
    const result = await enterprise.getSafetyViolations(ctx.account_id, {
      severity: url.searchParams.get('severity') || undefined,
      limit: parseInt(url.searchParams.get('limit') || '50'),
    });
    return json(result);
  } catch (e: unknown) { return err('Internal error'); }
});

router.post('/v1/safety/check', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    // Auto-log this API call as a decision (non-blocking, fire-and-forget)
    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: request.url.split(new URL(request.url).origin).pop() || request.url,
      statusCode: 200,

      tier: ctx.tier,
    }).catch(() => {});
    const body = await request.json() as Record<string, unknown>;
    const enterprise = new EnterpriseService(env.DB, env.ENCRYPTION_KEY);
    const result = enterprise.checkDecisionSafety(
      String(body.decision_type || ''), body.context as Record<string, unknown> || {}, String(body.outcome || '')
    );
    return json(result);
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 20: STREAMING (SSE) =============

router.get('/v1/stream', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    // Auto-log this API call as a decision (non-blocking, fire-and-forget)
    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: request.url.split(new URL(request.url).origin).pop() || request.url,
      statusCode: 200,

      tier: ctx.tier,
    }).catch(() => {});

    const url = getUrl(request);
    const format = url.searchParams.get('format') || 'sse';
    const decisionType = url.searchParams.get('decision_type') || 'all';

    if (format === 'sse') {
      // Server-Sent Events stream
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Send initial connection event
      const connectEvent = `event: connected\ndata: ${JSON.stringify({ decision_type: decisionType, timestamp: new Date().toISOString() })}\n\n`;
      writer.write(encoder.encode(connectEvent));

      // Send recent decisions as catch-up
      const decisionService = new DecisionService(env.DB, env.AI);
      const recent = await decisionService.listDecisions(ctx.account_id, { decision_type: decisionType !== 'all' ? decisionType : undefined, limit: 10 });

      for (const decision of recent) {
        const event = `event: decision_logged\ndata: ${JSON.stringify({ decision, timestamp: new Date().toISOString() })}\n\n`;
        writer.write(encoder.encode(event));
      }

      // Send heartbeat and close after a brief period (Workers have execution limits)
      const heartbeat = `event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`;
      writer.write(encoder.encode(heartbeat));

      // Close after sending catch-up data (Workers can't hold long-lived connections)
      writer.close();

      // M2 fix: Use CORS whitelist instead of hardcoded origin
      const sseOrigin = request.headers.get('Origin') || '';
      const sseCorsOrigin = ALLOWED_ORIGINS.includes(sseOrigin) ? sseOrigin : ALLOWED_ORIGINS[0];
      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': sseCorsOrigin,
        },
      });
    }

    return err('Unsupported stream format. Use format=sse', 400);
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= UNIFIED WORKFLOW: ALL 20 TIERS AS ONE =============

router.post('/v1/workflow/before', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const body = (await request.json()) as Record<string, unknown>;
    if (!body.decision_type || !body.action || !body.description) {
      return err('Missing required fields: decision_type, action, description', 400);
    }

    const qualityResult = validateActionQuality(String(body.description || body.action || ''));
    const strictQualityMode = isStrictQualityMode(env, ctx);
    if (!qualityResult.valid && strictQualityMode) {
      return actionQualityError(qualityResult);
    }

    // Auto-log this API call as a decision (non-blocking, fire-and-forget)
    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: request.url.split(new URL(request.url).origin).pop() || request.url,
      statusCode: 200,
      tier: ctx.tier,
      body,
    }).catch(() => {});

    const workflow = new WorkflowService(env.DB, env.AI);
    const wfSessionId = request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null;
    const result = await workflow.before(
      {
        decision_type: String(body.decision_type || ''),
        action: String(body.action || ''),
        description: String(body.description || ''),
        session_id: wfSessionId,
      },
      ctx.account_id,
      ctx.tier
    );

    const response: Record<string, unknown> = { ...result };
    if (!qualityResult.valid && !strictQualityMode) {
      response.warnings = [...((result.warnings || []) as Record<string, unknown>[]), actionQualityWarning(qualityResult)];
    }

    return json(response, 200);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('POST /v1/workflow/before error:', msg);
    return err('Failed to prepare workflow context', 500);
  }
});

router.post('/v1/workflow/after', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const body = (await request.json()) as Record<string, unknown>;
    if (!body.decision_id || body.success === undefined || !body.outcome) {
      return err('Missing required fields: decision_id, success, outcome', 400);
    }

    const qualityResult = validateActionQuality(String(body.outcome || ''));
    const strictQualityMode = isStrictQualityMode(env, ctx);
    if (!qualityResult.valid && strictQualityMode) {
      return actionQualityError(qualityResult);
    }

    // Auto-log this API call as a decision (non-blocking, fire-and-forget)
    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: request.url.split(new URL(request.url).origin).pop() || request.url,
      statusCode: 200,
      tier: ctx.tier,
      body,
    }).catch(() => {});

    const workflow = new WorkflowService(env.DB, env.AI);
    const workflowAfterAgentId = request.headers.get('X-Marrow-Agent-Id');
    const result = await workflow.after(
      {
        decision_id: String(body.decision_id || ''),
        success: Boolean(body.success),
        outcome: String(body.outcome || ''),
        related_decision_id: body.related_decision_id ? String(body.related_decision_id) : undefined,
        agent_id: workflowAfterAgentId || undefined,
      },
      ctx.account_id
    );

    const response: Record<string, unknown> = { ...result };
    if (!qualityResult.valid && !strictQualityMode) {
      response.warnings = [actionQualityWarning(qualityResult)];
    }

    return json(response, 200);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('POST /v1/workflow/after error:', msg);
    return err('Failed to record workflow outcome', 500);
  }
});

router.get('/v1/workflow/status', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    // Auto-log this API call as a decision (non-blocking, fire-and-forget)
    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: request.url.split(new URL(request.url).origin).pop() || request.url,
      statusCode: 200,

      tier: ctx.tier,
    }).catch(() => {});

    const workflow = new WorkflowService(env.DB, env.AI);
    const result = await workflow.status(ctx.account_id);

    return json(result, 200);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('GET /v1/workflow/status error:', msg);
    return err('Failed to retrieve platform status', 500);
  }
});

// Was a temporary admin-token-gated POST /v1/admin/catchup-batch route that
// fired catchup_v1 template to all existing users pre-2026-04-24. Sent cleanly,
// route is gone, MARROW_ADMIN_TOKEN secret deleted from prod worker.


// POST /v1/workflows/register
router.post('/v1/workflows/register', async (request: IRequest, env: Env) => {
  try {
    const ctx = await requireAuth(request, env);
    if (ctx instanceof Response) return ctx;

    const body = await request.json() as any;
    if (!body.name || !body.steps || !Array.isArray(body.steps)) {
      return err('Bad request: name and steps required', 400);
    }

    const service = new WorkflowRegistryService(env.DB);
    const result = await service.register(
      { name: body.name, description: body.description, steps: body.steps, tags: body.tags },
      ctx.account_id
    );

    return json(result, 201);
  } catch (e) {
    console.error('POST /v1/workflows/register error:', e);
    return err('Internal server error', 500);
  }
});

// GET /v1/workflows
router.get('/v1/workflows', async (request: IRequest, env: Env) => {
  try {
    const ctx = await requireAuth(request, env);
    if (ctx instanceof Response) return ctx;

    const url = getUrl(request);
    const status = url.searchParams.get('status') || undefined;

    const service = new WorkflowRegistryService(env.DB);
    const workflows = await service.list(ctx.account_id, status);

    return json({ workflows, count: workflows.length });
  } catch (e) {
    console.error('GET /v1/workflows error:', e);
    return err('Internal server error', 500);
  }
});

// GET /v1/workflows/:workflowId
router.get('/v1/workflows/:workflowId', async (request: IRequest, env: Env) => {
  try {
    const ctx = await requireAuth(request, env);
    if (ctx instanceof Response) return ctx;

    const workflowId = (request as any).params.workflowId;
    const service = new WorkflowRegistryService(env.DB);
    const workflow = await service.getById(workflowId, ctx.account_id);

    if (!workflow) return err('Not found', 404);
    return json({ workflow });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg.includes('Invalid') || msg.includes('UUID')) return err('Bad request', 400);
    console.error('GET /v1/workflows/:id error:', e);
    return err('Internal server error', 500);
  }
});

// PUT /v1/workflows/:workflowId
router.put('/v1/workflows/:workflowId', async (request: IRequest, env: Env) => {
  try {
    const ctx = await requireAuth(request, env);
    if (ctx instanceof Response) return ctx;

    const workflowId = (request as any).params.workflowId;
    const body = await request.json() as any;

    const service = new WorkflowRegistryService(env.DB);
    const workflow = await service.update(workflowId, ctx.account_id, {
      name: body.name,
      description: body.description,
      tags: body.tags,
      status: body.status,
    });

    if (!workflow) return err('Not found', 404);
    return json({ workflow });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg.includes('Invalid') || msg.includes('UUID')) return err('Bad request', 400);
    if (msg.includes('transition')) return err('Bad request', 400, { detail: msg });
    console.error('PUT /v1/workflows/:id error:', e);
    return err('Internal server error', 500);
  }
});

// POST /v1/workflows/:workflowId/start
router.post('/v1/workflows/:workflowId/start', async (request: IRequest, env: Env) => {
  try {
    const ctx = await requireAuth(request, env);
    if (ctx instanceof Response) return ctx;

    const workflowId = (request as any).params.workflowId;
    const body = await request.json() as any;

    const service = new WorkflowRegistryService(env.DB);
    const result = await service.start(workflowId, ctx.account_id, {
      agent_id: ctx.account_id, // H1: use auth-derived ID, not body
      context: body.context,
      inputs: body.inputs,
    });

    if (!result) return err('Workflow not found or not active', 404);
    return json({ workflowInstanceId: result.workflowInstanceId, currentStep: result.currentStep, nextAction: result.nextAction }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg.includes('Invalid') || msg.includes('UUID')) return err('Bad request', 400);
    console.error('POST /v1/workflows/:id/start error:', e);
    return err('Internal server error', 500);
  }
});

// PUT /v1/workflows/:workflowId/instances/:instanceId/step
router.put('/v1/workflows/:workflowId/instances/:instanceId/step', async (request: IRequest, env: Env) => {
  try {
    const ctx = await requireAuth(request, env);
    if (ctx instanceof Response) return ctx;

    const { instanceId } = (request as any).params;
    const body = await request.json() as any;

    if (body.step_completed === undefined || body.outcome === undefined) {
      return err('Bad request: step_completed and outcome required', 400);
    }

    const service = new WorkflowRegistryService(env.DB);
    const result = await service.advance(instanceId, ctx.account_id, {
      step_completed: body.step_completed,
      outcome: body.outcome,
      agent_id: body.agent_id, // Used for role enforcement against step's agent_role
      next_agent_id: body.next_agent_id,
      context_update: body.context_update,
      duration_ms: body.duration_ms,
      token_count: body.token_count,
    });

    if (!result) return err('Instance not found or not running', 404);
    return json({
      currentStep: result.currentStep,
      nextAction: result.nextAction,
      isComplete: result.isComplete,
      workflowOutcome: result.workflowOutcome,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg.includes('Step order violation') || msg.includes('Agent role mismatch')) return err(msg, 409);
    if (msg.includes('Invalid') || msg.includes('UUID')) return err('Bad request', 400);
    if (msg.includes('exceeds')) return err('Bad request', 400, { detail: msg });
    console.error('PUT /v1/workflows/:id/instances/:instanceId/step error:', e);
    return err('Internal server error', 500);
  }
});

// GET /v1/workflows/:workflowId/instances
router.get('/v1/workflows/:workflowId/instances', async (request: IRequest, env: Env) => {
  try {
    const ctx = await requireAuth(request, env);
    if (ctx instanceof Response) return ctx;

    const workflowId = (request as any).params.workflowId;
    const url = getUrl(request);
    const status = url.searchParams.get('status') || undefined;

    const service = new WorkflowRegistryService(env.DB);
    const instances = await service.listInstances(workflowId, ctx.account_id, status);

    return json({ instances, count: instances.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg.includes('Invalid') || msg.includes('UUID')) return err('Bad request', 400);
    console.error('GET /v1/workflows/:id/instances error:', e);
    return err('Internal server error', 500);
  }
});

// ============= Feature 1: Operator Dashboard API =============
router.get('/v1/dashboard', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    autoLogDecision({ db: env.DB, accountId: ctx.account_id, method: request.method, endpoint: '/v1/dashboard', statusCode: 200, tier: ctx.tier, sessionId: request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null }).catch(() => {});

    const rlAllowed = await checkRateLimit(env.DB, `dashboard:${ctx.account_id}`, 30, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const dashboard = new DashboardService(env.DB);
    const data = await dashboard.getDashboard(ctx.account_id);

    return json(data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('GET /v1/dashboard error:', msg);
    return err('Internal server error', 500);
  }
});

// ============= Feature 5: Accept Detected Workflow =============
router.post('/v1/workflows/accept-detected', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    autoLogDecision({ db: env.DB, accountId: ctx.account_id, method: request.method, endpoint: '/v1/workflows/accept-detected', statusCode: 200, tier: ctx.tier, sessionId: request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null }).catch(() => {});

    const rlAllowed = await checkRateLimit(env.DB, `workflow_accept_detected:${ctx.account_id}`, 10, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const body = await request.json() as Record<string, unknown>;
    if (!body.detected_id || typeof body.detected_id !== 'string') {
      return err('detected_id is required', 400);
    }
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(String(body.detected_id))) {
      return err('detected_id must be a valid UUID', 400);
    }

    const detectionService = new WorkflowDetectionService(env.DB);
    const workflowRegistry = new WorkflowRegistryService(env.DB);
    const result = await detectionService.acceptDetected(
      String(body.detected_id),
      ctx.account_id,
      workflowRegistry
    );

    if (!result) return err('Detected workflow not found or already accepted', 404);
    return json({ workflow_id: result.workflowId, version: result.version });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('POST /v1/workflows/accept-detected error:', msg);
    return err('Internal server error', 500);
  }
});

// ============= Feature 8: Weekly Digest =============
router.get('/v1/digest', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    autoLogDecision({ db: env.DB, accountId: ctx.account_id, method: request.method, endpoint: '/v1/digest', statusCode: 200, tier: ctx.tier, sessionId: request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null }).catch(() => {});

    const rlAllowed = await checkRateLimit(env.DB, `digest:${ctx.account_id}`, 30, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const url = getUrl(request);
    const period = parseInt(url.searchParams.get('period') || '7');
    const days = Math.min(Math.max(period, 1), 30);

    const dashboard = new DashboardService(env.DB);
    const impact = new ImpactService(env.DB);
    const baseline = new BaselineService(env.DB);

    // P4 fix: Query decisions directly instead of relying on daily_stats (which may be empty)
    const [currentPeriod, previousPeriod, dashboardData, savesCount, improvementData] = await Promise.all([
      env.DB.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as successful,
               SUM(CASE WHEN outcome_success = 0 THEN 1 ELSE 0 END) as failed
        FROM decisions
        WHERE account_id = ? AND created_at > datetime('now', ?) AND outcome_recorded_at IS NOT NULL AND outcome_success IS NOT NULL
      `).bind(ctx.account_id, `-${days} days`).first<{ total: number; successful: number; failed: number }>(),
      env.DB.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as successful,
               SUM(CASE WHEN outcome_success = 0 THEN 1 ELSE 0 END) as failed
        FROM decisions
        WHERE account_id = ? AND created_at > datetime('now', ?) AND created_at <= datetime('now', ?) AND outcome_recorded_at IS NOT NULL AND outcome_success IS NOT NULL
      `).bind(ctx.account_id, `-${days * 2} days`, `-${days} days`).first<{ total: number; successful: number; failed: number }>(),
      dashboard.getDashboard(ctx.account_id),
      impact.getSavesCount(ctx.account_id),
      baseline.getAccountImprovement(ctx.account_id),
    ]);

    const totalDecisions = currentPeriod?.total || 0;
    const successfulDecisions = currentPeriod?.successful || 0;
    const failedDecisions = currentPeriod?.failed || 0;
    const currentRate = totalDecisions > 0 ? successfulDecisions / totalDecisions : 0;

    const prevTotal = previousPeriod?.total || 0;
    const prevSuccessful = previousPeriod?.successful || 0;
    const previousRate = prevTotal > 0 ? prevSuccessful / prevTotal : 0;
    const change = currentRate - previousRate;
    const direction = change > 0.01 ? 'improving' : change < -0.01 ? 'declining' : 'stable';

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

    // Top risks: decision types with highest failure rates
    const topFailureTypes = (dashboardData.top_failures as Array<{ decision_type: string; failure_rate: number; count: number }>) || [];
    const topRisks = topFailureTypes.map(f => `${f.decision_type} has ${Math.round(f.failure_rate * 100)}% failure rate (${f.count} failures)`);

    const wfStatus = dashboardData.workflow_status as { completed_this_week: number; stalled: number };
    const velocity = (dashboardData.velocity as {
      attempts_per_success: VelocityMetric;
      time_to_success_seconds: VelocityMetric;
      drift_rate: VelocityMetric;
    }) || {
      attempts_per_success: { current: 0, previous: 0, delta_pct: 0, direction: 'stable' as const },
      time_to_success_seconds: { current: 0, previous: 0, delta_pct: 0, direction: 'stable' as const },
      drift_rate: { current: 0, previous: 0, delta_pct: 0, direction: 'stable' as const },
    };

    const improvement = (improvementData as ImprovementResult) || {
      status: 'onboarding' as const,
      days_elapsed: 0,
      decisions_elapsed: 0,
      days_until_time_trigger: 7,
      decisions_until_volume_trigger: 20,
      reason: 'Baseline captures on day 7 or after 20 decisions, whichever comes first.',
    };

    const improvementSentence = improvement.status === 'active'
      ? `Since onboarding ${improvement.days_since_baseline} days ago, your agents are ${Math.abs(improvement.time_to_success_seconds.delta_pct)}% faster and make ${Math.abs(improvement.attempts_per_success.delta_pct)}% ${improvement.attempts_per_success.delta_pct >= 0 ? 'more' : 'fewer'} attempts per success. That's ${improvement.decisions_since_baseline} decisions of compounding.`
      : `Currently onboarding — baseline snapshot takes at day 7 or 20 decisions (whichever first). ${improvement.days_until_time_trigger} days / ${improvement.decisions_until_volume_trigger} decisions to go.`;

    const summary = `${totalDecisions} decisions this period, ${Math.round(currentRate * 100)}% success rate (${direction}). ${savesCount.thisWeek} failures prevented by pattern matching. Agents completed tasks in ${velocity.time_to_success_seconds.current}s median (${velocity.time_to_success_seconds.direction} vs prior), with ${velocity.attempts_per_success.current} attempts per success on average. ${improvementSentence}`;

    return json({
      period: `${startDate} to ${endDate}`,
      summary,
      decisions: {
        total: totalDecisions,
        successful: successfulDecisions,
        failed: failedDecisions,
      },
      success_rate: {
        current: currentRate,
        previous_period: previousRate,
        change,
        direction,
      },
      saves: {
        count: savesCount.thisWeek,
        details: [],
      },
      velocity,
      top_improvements: [],
      top_risks: topRisks,
      workflows_completed: wfStatus.completed_this_week,
      workflows_stalled: wfStatus.stalled,
      improvement,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('GET /v1/digest error:', msg);
    return err('Internal server error', 500);
  }
});
// GET /v1/fleet — fleet status
router.all('*', (request: IRequest) => err('Route not found', 404, { path: getUrl(request).pathname, method: request.method }));

// ============= Export =============

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const runtimeEnv = { ...env, EXECUTION_CONTEXT: ctx };
      const response = await router.handle(request, runtimeEnv, ctx);
      const res = response || err('Not found', 404);
      // Inject CORS headers on all responses
      const origin = request.headers.get('Origin') || '';
      const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
      const newHeaders = new Headers(res.headers);
      newHeaders.set('Access-Control-Allow-Origin', allowedOrigin);
      newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      newHeaders.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      // M1 fix: Security headers on all responses
      newHeaders.set('X-Content-Type-Options', 'nosniff');
      newHeaders.set('X-Frame-Options', 'DENY');
      newHeaders.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');
      newHeaders.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      return new Response(res.body, { status: res.status, headers: newHeaders });
    } catch (e: unknown) {
      // Structured log so the failure is queryable in Cloudflare Workers
      // Observability — captures the request shape that caused the unhandled error.
      const url = new URL(request.url);
      log.error('unhandled_fetch_error', e, {
        component: 'worker.fetch',
        route: `${request.method} ${url.pathname}`,
        request_id: request.headers.get('cf-ray') || undefined,
      });
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Tier 10: Recalculate priorities every 6 hours
    const analytics = new AnalyticsService(env.DB);
    await analytics.getSystemAnalytics();

    // Retention cleanup — delete decisions past tier limits
    try {
      const retention = new RetentionService(env.DB);
      const deleted = await retention.cleanup();
      if (deleted > 0) console.log(`[retention] cleaned up ${deleted} expired decisions`);
    } catch (e) { console.error('[retention] error:', e); }

    // Feature 2: Auto-commit stale sessions (every 6h)
    try {
      const sessionSvc = new SessionService(env.DB);
      const committed = await sessionSvc.autoCommitStale();
      if (committed > 0) console.log(`[session] auto-committed ${committed} stale decisions`);
    } catch (e) { console.error('[session] auto-commit error:', e); }

    // V6.7: Day-3 nudge email batch (up to 100 per run, fire-and-forget)
    try {
      const now = Date.now();
      const newerThan = new Date(now - 96 * 60 * 60 * 1000).toISOString();
      const olderThan = new Date(now - 72 * 60 * 60 * 1000).toISOString();
      const eligible = await env.DB
        .prepare(`
          SELECT a.id, a.email
          FROM accounts a
          WHERE a.created_at >= ?
            AND a.created_at < ?
            AND a.email IS NOT NULL
            AND a.email != ''
            AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.account_id = a.id)
            AND NOT EXISTS (
              SELECT 1 FROM emails_sent e
              WHERE e.account_id = a.id AND e.template_name = 'day3_nudge'
            )
          ORDER BY a.created_at ASC
          LIMIT 100
        `)
        .bind(newerThan, olderThan)
        .all<{ id: string; email: string }>();

      const emailService = new EmailService(env.DB, env);
      for (const account of eligible.results || []) {
        try {
          const allowed = await emailService.canSendTemplate(account.id, 'day3_nudge');
          if (!allowed.ok) continue;

          // SECURITY: never mint or email API keys here. The user already has
          // their original key from the signup verification response. The
          // template directs them to use it via MARROW_API_KEY=<your-key> pattern.
          // Fire-and-forget: a single send failure never aborts the cron loop.
          emailService.sendTemplate(account.id, account.email, 'day3_nudge', {
            email: account.email,
          }).catch((err) => console.error('[email] day3_nudge send error:', account.id, err));
        } catch (e) {
          console.error('[email] day3_nudge prep error:', e);
        }
      }
    } catch (e) { console.error('[email] day3_nudge cron error:', e); }

    // L1 fix: Cleanup orphaned saves older than 7 days (unconfirmed potential saves)
    try {
      const saveCleanup = await env.DB.prepare(
        "DELETE FROM saves WHERE confirmed_save = 0 AND created_at < datetime('now', '-7 days')"
      ).run();
      const cleaned = saveCleanup.meta?.changes ?? 0;
      if (cleaned > 0) console.log(`[saves] cleaned up ${cleaned} orphaned saves`);
    } catch (e) { console.error('[saves] cleanup error:', e); }

    // Daily jobs — check if we've already run today
    try {
      const today = new Date().toISOString().split('T')[0];
      const lastRun = await env.DB.prepare(
        "SELECT recorded_at FROM analytics_snapshots WHERE metric_name = 'cron_daily_run' ORDER BY recorded_at DESC LIMIT 1"
      ).first<{ recorded_at: string }>();

      if (lastRun && lastRun.recorded_at.startsWith(today)) {
        console.log('[cron] daily jobs already run today, skipping');
      } else {
        // Feature 3: Rollup daily stats
        const trends = new TrendsService(env.DB);
        const accountsProcessed = await trends.rollupDaily();
        console.log(`[trends] rolled up ${accountsProcessed} accounts`);

        // Feature 4: Aggregate collective patterns
        const collective = new CollectiveService(env.DB);
        const patternsProcessed = await collective.aggregatePatterns();
        console.log(`[collective] aggregated ${patternsProcessed} patterns`);

        // Feature 5: Detect workflows per account
        const allAccounts = await env.DB.prepare(
          'SELECT DISTINCT account_id FROM decisions LIMIT 500'
        ).all<{ account_id: string }>();
        for (const row of allAccounts.results || []) {
          try {
            const detection = new WorkflowDetectionService(env.DB);
            await detection.detectPatterns(row.account_id);
          } catch (e) { console.error(`[workflow-detection] account ${row.account_id}:`, e); }
        }

        // Mark daily jobs done
        await env.DB.prepare(
          "INSERT INTO analytics_snapshots (id, metric_name, value, recorded_at, created_at) VALUES (?, 'cron_daily_run', 1, ?, ?)"
        ).bind(crypto.randomUUID(), new Date().toISOString(), new Date().toISOString()).run();
      }
    } catch (e) { console.error('[cron] daily jobs error:', e); }

    // V5: Update agent statuses (every cron run ~30s if configured, or ~6h with current schedule)
    try {
      const fleetSvc = new FleetService(env.DB);
      const allFleetAccounts = await env.DB.prepare(
        'SELECT DISTINCT account_id FROM agents WHERE status != ? LIMIT 200'
      ).bind('archived').all<{ account_id: string }>();
      for (const row of allFleetAccounts.results || []) {
        await fleetSvc.updateAgentStatuses(row.account_id);
      }
    } catch (e) { console.error('[fleet] agent status update error:', e); }
  },
};
