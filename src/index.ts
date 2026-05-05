/**
 * Marrow API — Complete 20-Tier Platform
 * Cloudflare Workers + D1 + itty-router
 */
import { Router, IRequest } from 'itty-router';
import { Env, RequestContext, ApiResponse, ApiKeyScope, ManagedApiKey } from './types';
import { AuthRateLimitError, AuthService, AuthServiceError } from './services/auth.service';
import { DecisionService } from './services/decision.service';
import { CollaborationService } from './services/collaboration.service';
import { PatternsService } from './services/patterns.service';
import { EnterpriseService } from './services/enterprise.service';
import { AnalyticsService } from './services/analytics.service';
import { AuditService } from './services/audit.service';
import { FeedbackService } from './services/feedback.service';
import { CausalityService } from './services/causality.service';
import { PriorityService } from './services/priority.service';
import { PatternRecognitionService } from './services/pattern-recognition.service';
import { TransferService } from './services/transfer.service';
import { BootstrapService } from './services/bootstrap.service';
import { ConsensusService } from './services/consensus.service';
import { SnapshotService } from './services/snapshot.service';
import { VersionService } from './services/version.service';
import { MarketplaceService } from './services/marketplace.service';
import { WorkflowService } from './workflow';
import { OtpService } from './services/otp.service';
import { log } from './utils/logger';
import { WebhookService } from './services/webhook.service';
import { OrgService } from './services/org.service';
import { RetentionService } from './services/retention.service';
import { PiiService } from './services/pii.service';
import { WorkflowRegistryService } from './services/workflow-registry.service';
import { TrendsService } from './services/trends.service';
import { SessionService } from './services/session.service';
import { ImpactService } from './services/impact.service';
import { DashboardService } from './services/dashboard.service';
import { CollectiveService } from './services/collective.service';
import { WorkflowDetectionService } from './services/workflow-detection.service';
import { AgentService } from './services/agent.service';
import { TemplatesService } from './services/templates.service';
import { FleetService } from './services/fleet.service';
import { NarrativeService } from './services/narrative.service';
import { NudgeService } from './services/nudge.service';
import { EmailService } from './services/email.service';
import { MemoryService } from './services/memory.service';
import type { VelocityMetric } from './services/velocity.service';
import type { ImprovementResult } from './services/baseline.service';
import { BaselineService } from './services/baseline.service';
import { checkRateLimit } from './utils/rate-limit';
import { PatternEngine } from './pattern-engine';
import { autoLogDecision, classifyDecisionQuality } from './middleware/auto-logger';
import { actionQualityWarning, isStrictQualityMode, validateActionQuality } from './middleware/action-validator';
import { getDedupedResponse, storeDedupedResponse } from './middleware/dedup-cache';
import { safely } from './utils/safely';
import { router as authRouter } from './routes/auth';
import { router as memoriesRouter } from './routes/memories';
import { router as agentRouter } from './routes/agent';

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
router.post('/decisions', async (request: IRequest, env: Env) => {
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
    const decisionService = new DecisionService(env.DB, env.AI);
    const enterpriseService = new EnterpriseService(env.DB, env.ENCRYPTION_KEY);

    const validation = decisionService.validateDecision(body);
    if (!validation.valid) return err('Validation failed', 400, validation.errors);

    // Tier 19: Safety check (async, non-blocking)
    const safety = enterpriseService.checkDecisionSafety(
      String(body.decision_type), body.context as Record<string, unknown>, String(body.outcome)
    );
    // Record violations asynchronously (don't block response)
    Promise.all([
      safety.violations.filter(v => v.severity === 'critical').map(v =>
        enterpriseService.recordViolation(null, v.type, 'critical', 'block')
      ),
      safety.violations.map(v =>
        enterpriseService.recordViolation(null, v.type, v.severity as 'low' | 'medium' | 'high' | 'critical', v.action)
      )
    ]).catch(() => {}); // Ignore errors

    // Look up org settings — PII strip + default visibility (hive contribution control)
    let orgPiiStripTeam = false;
    let orgDefaultVisibility: 'private' | 'shared' | 'hive' | 'team' | null = null;
    const requestedVis = (body.visibility as string) || null;
    if (ctx.tier === 'enterprise') {
      const orgSvc = new OrgService(env.DB);
      const org = await orgSvc.getOrgForAccount(ctx.account_id);
      if (org) {
        orgPiiStripTeam = !!org.pii_strip_team;
        // Use org default_visibility if user didn't explicitly set one
        if (!requestedVis && org.default_visibility) {
          orgDefaultVisibility = org.default_visibility as 'private' | 'shared' | 'hive' | 'team';
        }
      }
    }

    // Gap 4: Detect PII sanitization
    const piiCheck = new PiiService();
    const outcomeStr = String(body.outcome || '');
    const strippedOutcome = piiCheck.stripString(outcomeStr);
    const decisionSanitized = strippedOutcome !== outcomeStr;

    const decision = await decisionService.createDecision(
      ctx.account_id,
      String(body.decision_type),
      body.context as Record<string, unknown>,
      outcomeStr,
      Number(body.confidence),
      (body.visibility as 'private' | 'shared' | 'hive' | 'team') || orgDefaultVisibility || 'hive',
      ctx.tier,
      orgPiiStripTeam
    );

    // M3 fix: Removed duplicate first-decision email trigger.
    // Onboarding email is now owned exclusively by POST /v1/agent/think via first_think_at (race-safe from M1 fix).

    return json({ ...decision, sanitized: decisionSanitized }, 201);
  } catch (e: unknown) {
    console.error('POST /v1/decisions error:', e);
    return err('Internal error');
  }
});

// GET /decisions
router.get('/decisions', async (request: IRequest, env: Env) => {
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
    const decisionService = new DecisionService(env.DB, env.AI);
    const decisions = await decisionService.listDecisions(ctx.account_id, {
      decision_type: url.searchParams.get('decision_type') || undefined,
      limit: parseInt(url.searchParams.get('limit') || '50'),
      offset: parseInt(url.searchParams.get('offset') || '0'),
    });
    return json(decisions);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/decisions/shared', async (request: IRequest, env: Env) => {
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
    const collab = new CollaborationService(env.DB);
    const shared = await collab.getSharedDecisions(
      ctx.account_id,
      parseInt(url.searchParams.get('limit') || '50'),
      parseInt(url.searchParams.get('offset') || '0')
    );
    return json(shared);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/decisions/routing-suggestions', async (request: IRequest, env: Env) => {
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
    const decisionType = url.searchParams.get('decision_type') || 'general';
    const patterns = new PatternsService(env.DB, env.AI);
    const { similar: suggestions } = await patterns.predictSimilarDecisions({ type: decisionType }, decisionType, 5);
    return json({ routing_suggestions: suggestions });
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/decisions/priority', async (request: IRequest, env: Env) => {
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
    const priorityService = new PriorityService(env.DB);
    const queue = await priorityService.getQueueByPriority(ctx.account_id, parseInt(url.searchParams.get('limit') || '50'));
    return json(queue);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/decisions/:id', async (request: IRequest, env: Env) => {
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
    const decisionService = new DecisionService(env.DB, env.AI);
    const decision = await decisionService.getDecision(String(request.params?.id), ctx.account_id);
    if (!decision) return err('Not found', 404);
    return json(decision);
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 3: OUTCOME FEEDBACK =============

router.put('/v1/decisions/:id/outcome', async (request: IRequest, env: Env) => {
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
    const feedbackService = new FeedbackService(env.DB);
    const outcome = await feedbackService.recordOutcome(
      String(request.params?.id), ctx.account_id,
      Boolean(body.success), body.feedback as string | undefined, body.details as Record<string, unknown> | undefined
    );
    return json(outcome);
  } catch (e: unknown) {
    return err('Internal error');
  }
});

router.get('/v1/decisions/:id/outcome', async (request: IRequest, env: Env) => {
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

    const feedbackService = new FeedbackService(env.DB);
    const outcome = await feedbackService.getOutcome(String(request.params?.id), ctx.account_id);
    if (!outcome) return err('Not found', 404);
    return json(outcome);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/decisions/feedback/history', async (request: IRequest, env: Env) => {
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
    const feedbackService = new FeedbackService(env.DB);
    const history = await feedbackService.getOutcomeHistory(ctx.account_id, parseInt(url.searchParams.get('limit') || '50'), parseInt(url.searchParams.get('offset') || '0'));
    return json(history);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/feedback/metrics', async (request: IRequest, env: Env) => {
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
    const feedbackService = new FeedbackService(env.DB);
    const metrics = await feedbackService.getSuccessMetrics(ctx.account_id, url.searchParams.get('decision_type') || undefined);
    return json(metrics);
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 4: COLLABORATION =============

router.post('/v1/decisions/:id/share', async (request: IRequest, env: Env) => {
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
    if (!body.trust_score || typeof body.trust_score !== 'number' || body.trust_score < 0 || body.trust_score > 1) {
      return err('trust_score is required and must be a number between 0-1', 400);
    }
    if (!body.shared_with_account_id || typeof body.shared_with_account_id !== 'string' || String(body.shared_with_account_id).trim() === '') {
      return err('shared_with_account_id is required and must be a non-empty string', 400);
    }
    const collab = new CollaborationService(env.DB);
    const share = await collab.shareDecision(
      String(request.params?.id), ctx.account_id,
      String(body.shared_with_account_id), Number(body.trust_score)
    );
    return json(share, 201);
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 6: CAUSALITY =============

router.post('/v1/decisions/:id/caused-by', async (request: IRequest, env: Env) => {
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
    if (!body.cause_id || typeof body.cause_id !== 'string' || String(body.cause_id).trim() === '') {
      return err('cause_id is required and must be a non-empty string', 400);
    }
    const causalityService = new CausalityService(env.DB);
    const edge = await causalityService.addCausalityEdge(
      String(body.cause_id), String(request.params?.id),
      String(body.reasoning), ctx.account_id, Number(body.strength || 1.0)
    );
    return json(edge, 201);
  } catch (e: unknown) {
    return err('Internal error');
  }
});

router.get('/v1/decisions/:id/causality', async (request: IRequest, env: Env) => {
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

    const causalityService = new CausalityService(env.DB);
    const graph = await causalityService.getCausalityGraph(String(request.params?.id), ctx.account_id);
    return json(graph);
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 7: PREDICTIVE =============

router.post('/v1/decisions/predict', async (request: IRequest, env: Env) => {
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
    const patterns = new PatternsService(env.DB, env.AI);
    const { similar } = await patterns.predictSimilarDecisions(
      body.context as Record<string, unknown>, String(body.decision_type), 5
    );
    return json({ similar_decisions: similar });
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 8: PATTERNS & TRENDS =============

router.get('/v1/patterns', async (request: IRequest, env: Env) => {
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
    const prService = new PatternRecognitionService(env.DB);
    const patterns = await prService.recognizePatterns(ctx.account_id, url.searchParams.get('decision_type') || undefined);
    return json(patterns);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/patterns/:id', async (request: IRequest, env: Env) => {
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

    const prService = new PatternRecognitionService(env.DB);
    const stats = await prService.getPatternStats(String(request.params?.id), ctx.account_id);
    return json(stats);
  } catch (e: unknown) { return err('Internal error'); }
});

router.post('/v1/patterns/:id/validate', async (request: IRequest, env: Env) => {
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
    const prService = new PatternRecognitionService(env.DB);
    const result = await prService.validatePattern(String(request.params?.id), String(body.decision_id), ctx.account_id);
    return json(result);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/trends', async (request: IRequest, env: Env) => {
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
    const patterns = new PatternsService(env.DB, env.AI);
    const result = await patterns.calculateTrends(ctx.account_id, url.searchParams.get('decision_type') || 'general');
    return json(result);
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 9: TRANSFER LEARNING =============

router.get('/v1/lessons/transfer', async (request: IRequest, env: Env) => {
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
    const transferService = new TransferService(env.DB);
    const lessons = await transferService.getTransferableLessons(
      url.searchParams.get('from_type') || 'general',
      url.searchParams.get('to_type') || 'general',
      parseInt(url.searchParams.get('limit') || '10')
    );
    return json(lessons);
  } catch (e: unknown) { return err('Internal error'); }
});

router.post('/v1/lessons/:id/transfer-to', async (request: IRequest, env: Env) => {
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
    const transferService = new TransferService(env.DB);
    const result = await transferService.transferLesson(
      String(request.params?.id), ctx.account_id,
      String(body.from_domain), String(body.to_domain)
    );
    return json(result, 201);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/transfer-metrics', async (request: IRequest, env: Env) => {
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
    const transferService = new TransferService(env.DB);
    const metrics = await transferService.calculateTransferMetrics(
      ctx.account_id,
      url.searchParams.get('from_domain') || 'general',
      url.searchParams.get('to_domain') || 'general'
    );
    return json(metrics);
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 10: PRIORITY QUEUE =============

router.get('/v1/decisions/priority', async (request: IRequest, env: Env) => {
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
    const priorityService = new PriorityService(env.DB);
    const queue = await priorityService.getQueueByPriority(ctx.account_id, parseInt(url.searchParams.get('limit') || '50'));
    return json(queue);
  } catch (e: unknown) { return err('Internal error'); }
});

router.post('/v1/decisions/:id/prioritize', async (request: IRequest, env: Env) => {
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
    const urgencyOptions = ['low', 'normal', 'high', 'critical'];
    if (!body.urgency || !urgencyOptions.includes(String(body.urgency))) {
      return err('urgency is required and must be one of: low, normal, high, critical', 400);
    }
    if (!body.impact || typeof body.impact !== 'number' || body.impact < 0 || body.impact > 1) {
      return err('impact is required and must be a number between 0-1', 400);
    }
    const priorityService = new PriorityService(env.DB);
    const priority = await priorityService.calculatePriority(
      String(request.params?.id), ctx.account_id,
      String(body.urgency) as 'low' | 'normal' | 'high' | 'critical',
      Number(body.impact)
    );
    return json(priority);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/queue/status', async (request: IRequest, env: Env) => {
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

    const priorityService = new PriorityService(env.DB);
    const status = await priorityService.getQueueStatus(ctx.account_id);
    return json(status);
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 10: HIVE (LEGACY ALIAS) =============

router.get('/v1/hive', async (request: IRequest, env: Env) => {
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
    const patterns = new PatternsService(env.DB, env.AI);
    const sort = url.searchParams.get('sort') || 'priority';

    if (sort === 'priority') {
      await patterns.recalculatePriorities(ctx.account_id);
      const result = await patterns.getHiveByPriority(url.searchParams.get('decision_type') || 'general', 50, ctx.account_id);
      return json(result);
    }
    return err('Invalid sort parameter', 400);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/hive/signals', async (request: IRequest, env: Env) => {
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
    const patterns = new PatternsService(env.DB, env.AI);
    const decision_type = url.searchParams.get('decision_type') || 'general';
    const limit = parseInt(url.searchParams.get('limit') || '20');

    const signals = await patterns.getSignalsByAccountAndType(ctx.account_id, decision_type, limit);
    return json({ signals });
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 12: BOOTSTRAP =============

router.get('/v1/bootstrap', async (request: IRequest, env: Env) => {
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
    const bootstrapService = new BootstrapService(env.DB);
    const templates = await bootstrapService.getTemplates(url.searchParams.get('decision_type') || 'general');
    return json(templates);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/bootstrap/categories', async (request: IRequest, env: Env) => {
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
    const bootstrapService = new BootstrapService(env.DB);
    const categories = await bootstrapService.listCategories();
    return json({ categories });
  } catch (e: unknown) { return err('Internal error'); }
});

router.post('/v1/bootstrap/:id/apply', async (request: IRequest, env: Env) => {
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
    const bootstrapService = new BootstrapService(env.DB);
    const result = await bootstrapService.applyTemplate(
      String(request.params?.id), ctx.account_id,
      body.custom_params as Record<string, unknown> | undefined
    );
    return json(result, 201);
  } catch (e: unknown) { return err('Internal error'); }
});

router.post('/v1/bootstrap', async (request: IRequest, env: Env) => {
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
    const bootstrapService = new BootstrapService(env.DB);
    const template = await bootstrapService.createTemplate(
      String(body.decision_type), body.template_decisions as unknown[], Number(body.success_rate || 0.5),
      String(body.category || 'general')
    );
    return json(template, 201);
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 13: AUDIT =============

router.get('/v1/audit', async (request: IRequest, env: Env) => {
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
    const audit = new AuditService(env.DB);
    const result = await audit.getAuditLog({
      account_id: ctx.account_id,
      start_time: url.searchParams.get('start_time') || undefined,
      end_time: url.searchParams.get('end_time') || undefined,
      resource_type: url.searchParams.get('resource_type') || undefined,
      limit: parseInt(url.searchParams.get('limit') || '100'),
    });
    return json(result);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/audit/verify', async (request: IRequest, env: Env) => {
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
    const audit = new AuditService(env.DB);
    const result = await audit.verifyChain();
    return json(result);
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 13: HIVE CONSENSUS =============

router.post('/v1/decisions/:id/consensus-vote', async (request: IRequest, env: Env) => {
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
    const consensusService = new ConsensusService(env.DB);
    const voteType = String(body.vote_type || (body.agrees ? 'agree' : 'disagree')) as 'agree' | 'disagree' | 'abstain';
    const vote = await consensusService.recordVote(
      String(request.params?.id), ctx.account_id, voteType,
      body.reasoning as string | undefined
    );
    return json(vote, 201);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/hive/consensus', async (request: IRequest, env: Env) => {
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
    const consensusService = new ConsensusService(env.DB);
    const result = await consensusService.getHiveConsensus(
      url.searchParams.get('decision_type') || 'general',
      parseInt(url.searchParams.get('limit') || '50')
    );
    return json(result);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/consensus/metrics', async (request: IRequest, env: Env) => {
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
    const consensusService = new ConsensusService(env.DB);
    const analysis = await consensusService.detectDisagreement(
      url.searchParams.get('decision_id') || '',
      parseFloat(url.searchParams.get('threshold') || '0.3')
    );
    return json(analysis);
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 14: SNAPSHOTS & VERSIONING =============

router.post('/v1/snapshots', async (request: IRequest, env: Env) => {
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
    const snapshotService = new SnapshotService(env.DB, env.ENCRYPTION_KEY);
    const result = await snapshotService.createSnapshot(
      ctx.account_id,
      body.label as string | undefined,
      body.tags as string[] | undefined
    );
    return json(result, 201);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/snapshots', async (request: IRequest, env: Env) => {
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
    const snapshotService = new SnapshotService(env.DB, env.ENCRYPTION_KEY);
    const snapshots = await snapshotService.listSnapshots(ctx.account_id, parseInt(url.searchParams.get('limit') || '50'));
    return json(snapshots);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/snapshots/:id', async (request: IRequest, env: Env) => {
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

    const snapshotService = new SnapshotService(env.DB, env.ENCRYPTION_KEY);
    const snapshot = await snapshotService.getSnapshot(String(request.params?.id), ctx.account_id);
    if (!snapshot) return err('Not found', 404);
    return json(snapshot);
  } catch (e: unknown) { return err('Internal error'); }
});

router.post('/v1/snapshots/:id/diff', async (request: IRequest, env: Env) => {
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
    const snapshotService = new SnapshotService(env.DB, env.ENCRYPTION_KEY);
    const diff = await snapshotService.diffSnapshot(
      String(request.params?.id),
      String(body.comparison_snapshot_id),
      ctx.account_id
    );
    return json(diff);
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 15: SNAPSHOT RESTORE =============

router.post('/v1/snapshots/:id/restore', async (request: IRequest, env: Env) => {
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

    const snapshotService = new SnapshotService(env.DB, env.ENCRYPTION_KEY);
    const result = await snapshotService.restoreSnapshot(String(request.params?.id), ctx.account_id);
    return json(result);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/restore/status', async (request: IRequest, env: Env) => {
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
    const snapshotService = new SnapshotService(env.DB, env.ENCRYPTION_KEY);
    const status = await snapshotService.getRestoreStatus(url.searchParams.get('restore_id') || '', ctx.account_id);
    if (!status) return err('Not found', 404);
    return json(status);
  } catch (e: unknown) { return err('Internal error'); }
});

router.delete('/v1/snapshots/:id', async (request: IRequest, env: Env) => {
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

    const snapshotService = new SnapshotService(env.DB, env.ENCRYPTION_KEY);
    await snapshotService.deleteSnapshot(String(request.params?.id), ctx.account_id);
    return json({ deleted: true });
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 16: VERSION HISTORY =============

router.get('/v1/versions', async (request: IRequest, env: Env) => {
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
    const versionService = new VersionService(env.DB);
    const versions = await versionService.getVersions();
    return json(versions);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/versions/current', async (request: IRequest, env: Env) => {
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
    const versionService = new VersionService(env.DB);
    const version = await versionService.getCurrentVersion();
    if (!version) return err('No current version', 404);
    return json(version);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/versions/:from/migration/:to', async (request: IRequest, env: Env) => {
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
    const versionService = new VersionService(env.DB);
    const guide = await versionService.getMigrationGuide(String(request.params?.from), String(request.params?.to));
    if (!guide) return err('Migration guide not found', 404);
    return json(guide);
  } catch (e: unknown) { return err('Internal error'); }
});

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

// ============= TIER 18: MARKETPLACE =============

router.post('/v1/lessons', async (request: IRequest, env: Env) => {
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
    const title = String(body.title || '');
    const content = String(body.content || '');
    if (title.length > 200) return err('Title max 200 characters', 400);
    if (content.length > 5000) return err('Content max 5000 characters', 400);

    const collab = new CollaborationService(env.DB);
    const lesson = await collab.createLesson(
      ctx.account_id, title, content,
      body.domain_tags as string[] | undefined
    );
    return json(lesson, 201);
  } catch (e: unknown) { return err('Internal error'); }
});

router.post('/v1/lessons/:id/publish', async (request: IRequest, env: Env) => {
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

    const marketplaceService = new MarketplaceService(env.DB);
    const result = await marketplaceService.publishLesson(String(request.params?.id), ctx.account_id);
    return json(result);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/lessons/marketplace', async (request: IRequest, env: Env) => {
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
    const marketplaceService = new MarketplaceService(env.DB);
    const result = await marketplaceService.getMarketplace(
      (url.searchParams.get('sort_by') as 'rating' | 'reputation' | 'recent' | 'forks') || 'rating',
      parseInt(url.searchParams.get('limit') || '50')
    );
    return json(result);
  } catch (e: unknown) { return err('Internal error'); }
});

router.post('/v1/lessons/:id/fork', async (request: IRequest, env: Env) => {
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
    if (!body.to_domain || typeof body.to_domain !== 'string' || String(body.to_domain).trim() === '') {
      return err('to_domain is required and must be a non-empty string', 400);
    }
    const marketplaceService = new MarketplaceService(env.DB);
    const result = await marketplaceService.forkLesson(
      String(request.params?.id), ctx.account_id, String(body.to_domain)
    );
    return json(result, 201);
  } catch (e: unknown) { return err('Internal error'); }
});

router.post('/v1/lessons/:id/rate', async (request: IRequest, env: Env) => {
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
    if (!body.rating || typeof body.rating !== 'number' || body.rating < 1 || body.rating > 5) {
      return err('rating is required and must be a number between 1-5', 400);
    }
    const marketplaceService = new MarketplaceService(env.DB);
    await marketplaceService.rateLesson(String(request.params?.id), ctx.account_id, Number(body.rating));
    return json({ rated: true });
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/lessons/:id/versions', async (request: IRequest, env: Env) => {
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
    const marketplaceService = new MarketplaceService(env.DB);
    const versions = await marketplaceService.getLessonVersions(String(request.params?.id));
    return json(versions);
  } catch (e: unknown) { return err('Internal error'); }
});

// ============= TIER 19: SAFETY =============

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

// ============= TIER ARCHITECTURE: Webhooks (Pro+) =============

router.post('/v1/webhooks', async (request: IRequest, env: Env) => {
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
    if (ctx.tier === 'free') return err('Webhooks require Pro or Enterprise tier', 403);

    const body = await request.json() as { url?: string; secret?: string; decision_types?: string[] };
    if (!body.url || !body.secret) return err('url and secret required', 400);

    const svc = new WebhookService(env.DB, env.ENCRYPTION_KEY);
    try {
      const hook = await svc.create(ctx.account_id, body.url, body.secret, body.decision_types);
      return json(hook);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Internal error';
      if (msg.includes('not allowed') || msg.includes('max 500')) return err(msg, 400);
      return err('Internal error', 500);
    }
  } catch (e) { return err('Internal error', 500); }
});

router.get('/v1/webhooks', async (request: IRequest, env: Env) => {
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
    if (ctx.tier === 'free') return err('Webhooks require Pro or Enterprise tier', 403);

    const svc = new WebhookService(env.DB, env.ENCRYPTION_KEY);
    const hooks = await svc.list(ctx.account_id);
    // Strip secret, return hint only
    const safe = hooks.map(h => ({
      ...h,
      secret: undefined,
      secret_hint: h.secret ? (h.secret.length >= 8 ? `****${h.secret.slice(-4)}` : '****') : null,
    }));
    return json(safe);
  } catch (e) { return err('Internal error', 500); }
});

router.delete('/v1/webhooks/:id', async (request: IRequest, env: Env) => {
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

    const svc = new WebhookService(env.DB, env.ENCRYPTION_KEY);
    const deleted = await svc.delete(request.params.id, ctx.account_id);
    if (!deleted) return err('Not found', 404);
    return json({ deleted: true });
  } catch (e) { return err('Internal error', 500); }
});

// ============= TIER ARCHITECTURE: Org (Enterprise) =============

router.post('/v1/org', async (request: IRequest, env: Env) => {
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
    if (ctx.tier !== 'enterprise' && ctx.tier !== 'owner') return err('Org management requires Enterprise tier', 403);

    const body = await request.json() as { name?: string };
    if (!body.name) return err('name required', 400);
    if (body.name.length > 100) return err('Org name max 100 characters', 400);

    const svc = new OrgService(env.DB);
    const org = await svc.createOrg(body.name, ctx.account_id);
    return json(org);
  } catch (e) { return err('Internal error', 500); }
});

router.post('/v1/org/invite', async (request: IRequest, env: Env) => {
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
    if (ctx.tier !== 'enterprise' && ctx.tier !== 'owner') return err('Org management requires Enterprise tier', 403);

    const body = await request.json() as { account_id?: string; role?: string };
    if (!body.account_id) return err('account_id required', 400);
    const role = body.role || 'member';
    if (role !== 'admin' && role !== 'member') return err('role must be admin or member', 400);

    const orgSvc = new OrgService(env.DB);
    const org = await orgSvc.getOrgForAccount(ctx.account_id);
    if (!org) return err('No org found for your account', 404);

    // Only owner/admin can invite
    const callerRole = await env.DB
      .prepare('SELECT role FROM org_members WHERE org_id = ? AND account_id = ? LIMIT 1')
      .bind(org.id, ctx.account_id)
      .first<{ role: string }>();
    if (!callerRole || (callerRole.role !== 'owner' && callerRole.role !== 'admin')) {
      return err('Only org owners and admins can invite members', 403);
    }

    const member = await orgSvc.addMember(org.id, body.account_id, role as any);
    return json(member);
  } catch (e) { return err('Internal error', 500); }
});

router.put('/v1/org/settings', async (request: IRequest, env: Env) => {
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
    if (ctx.tier !== 'enterprise' && ctx.tier !== 'owner') return err('Org management requires Enterprise tier', 403);

    const body = await request.json() as { pii_strip_team?: boolean };
    const orgSvc = new OrgService(env.DB);
    const org = await orgSvc.getOrgForAccount(ctx.account_id);
    if (!org) return err('No org found for your account', 404);

    if (body.pii_strip_team !== undefined) {
      await orgSvc.updatePiiStripTeam(org.id, body.pii_strip_team);
    }

    const updated = await orgSvc.getOrgForAccount(ctx.account_id);
    return json(updated);
  } catch (e) { return err('Internal error', 500); }
});

router.get('/v1/org/members', async (request: IRequest, env: Env) => {
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
    if (ctx.tier !== 'enterprise' && ctx.tier !== 'owner') return err('Org management requires Enterprise tier', 403);

    const orgSvc = new OrgService(env.DB);
    const org = await orgSvc.getOrgForAccount(ctx.account_id);
    if (!org) return err('No org found', 404);

    const members = await orgSvc.listMembers(org.id);
    return json(members);
  } catch (e) { return err('Internal error', 500); }
});

// ============= ADMIN: Tier Management (Owner only) =============

router.put('/v1/admin/accounts/:accountId/tier', async (request: IRequest, env: Env) => {
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
    if (ctx.tier !== 'owner') return err('Owner tier required', 403);

    const body = await request.json() as { tier?: string };
    const validTiers = ['free', 'pro', 'enterprise', 'owner'];
    if (!body.tier || !validTiers.includes(body.tier)) {
      return err(`tier must be one of: ${validTiers.join(', ')}`, 400);
    }

    const authService = new AuthService(env.DB);
    const updated = await authService.updateAccountTier(
      request.params.accountId,
      body.tier as 'free' | 'pro' | 'enterprise' | 'owner'
    );
    if (!updated) return err('Account not found', 404);
    return json(updated);
  } catch (e) { return err('Internal error', 500); }
});

// Catch-up batch route removed 2026-04-24 after one-shot use (33 users batched).
// Was a temporary admin-token-gated POST /v1/admin/catchup-batch route that
// fired catchup_v1 template to all existing users pre-2026-04-24. Sent cleanly,
// route is gone, MARROW_ADMIN_TOKEN secret deleted from prod worker.

// ============= ADMIN: Password Auth (public — no API key needed) =============

router.post('/v1/admin/auth', async (request: IRequest, env: Env) => {
  try {
    const corsHeaders = getCorsHeaders(request);

    // C2 fix: Rate limit — 5 attempts per IP per 15 minutes
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const rateLimitAllowed = await checkRateLimit(env.DB, `admin_auth:${ip}`, 5, 15 * 60 * 1000);
    if (!rateLimitAllowed) {
      return new Response(JSON.stringify({ error: 'Too many attempts', code: 'RATE_LIMITED' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const body = await request.json() as { password?: string };
    const password = (body?.password || '').trim();

    // C1 fix: Constant-time password comparison via HMAC
    const isValid = password && env.ADMIN_DASHBOARD_PASSWORD
      ? await (async () => {
          const encoder = new TextEncoder();
          const aBytes = encoder.encode(password);
          const bBytes = encoder.encode(env.ADMIN_DASHBOARD_PASSWORD);
          if (aBytes.length !== bBytes.length) return false;
          const aKey = await crypto.subtle.importKey('raw', aBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
          const bKey = await crypto.subtle.importKey('raw', bBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
          const msg = encoder.encode('marrow');
          const aHmac = await crypto.subtle.sign('HMAC', aKey, msg);
          const bHmac = await crypto.subtle.sign('HMAC', bKey, msg);
          return Array.from(new Uint8Array(aHmac)).map(b => b.toString(16).padStart(2, '0')).join('')
            === Array.from(new Uint8Array(bHmac)).map(b => b.toString(16).padStart(2, '0')).join('');
        })()
      : false;

    if (!isValid) {
      return new Response(JSON.stringify({ error: 'Invalid password' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Inline the admin stats + trajectory queries directly (avoids self-referential fetch)
    const totalAccountsRow = await env.DB
      .prepare('SELECT COUNT(*) as count FROM accounts')
      .first<{ count: number }>();
    const activeAccountsRow = await env.DB
      .prepare("SELECT COUNT(DISTINCT account_id) as count FROM decisions WHERE created_at > datetime('now', '-30 days')")
      .first<{ count: number }>();
    const accountsResult = await env.DB
      .prepare(`
        SELECT a.id, a.name, a.email, a.tier, a.created_at,
          COUNT(d.id) as decision_count,
          MAX(d.created_at) as last_active
        FROM accounts a
        LEFT JOIN decisions d ON d.account_id = a.id
        GROUP BY a.id
        ORDER BY decision_count DESC
      `)
      .all<{ id: string; name: string; email: string; tier: string; created_at: string; decision_count: number; last_active: string | null }>();
    const totalDecisionsRow = await env.DB
      .prepare('SELECT COUNT(*) as count FROM decisions')
      .first<{ count: number }>();
    const decisions7dRow = await env.DB
      .prepare("SELECT COUNT(*) as count FROM decisions WHERE created_at > datetime('now', '-7 days')")
      .first<{ count: number }>();
    const decisions30dRow = await env.DB
      .prepare("SELECT COUNT(*) as count FROM decisions WHERE created_at > datetime('now', '-30 days')")
      .first<{ count: number }>();

    const statsData = {
      total_accounts: totalAccountsRow?.count ?? 0,
      active_accounts: activeAccountsRow?.count ?? 0,
      accounts: (accountsResult.results || []).map(a => ({
        id: a.id, name: a.name, email: a.email, tier: a.tier, created_at: a.created_at,
        decision_count: a.decision_count, last_active: a.last_active,
      })),
      total_decisions: totalDecisionsRow?.count ?? 0,
      decisions_last_7d: decisions7dRow?.count ?? 0,
      decisions_last_30d: decisions30dRow?.count ?? 0,
    };

    // Trajectory data
    const allAccounts = await env.DB
      .prepare('SELECT id, name FROM accounts')
      .all<{ id: string; name: string }>();
    const accountMap = new Map<string, string>();
    for (const a of (allAccounts.results || [])) {
      accountMap.set(a.id, a.name);
    }
    const trajectoryResult = await env.DB
      .prepare(`
        SELECT
          account_id,
          strftime('%Y-%m-%d', created_at, 'weekday 0', '-6 days') as week_start,
          COUNT(*) as decisions,
          AVG(CASE WHEN outcome_success = 1 THEN 1.0 ELSE 0.0 END) as success_rate,
          AVG(confidence) as avg_confidence
        FROM decisions
        WHERE outcome_success IS NOT NULL
        GROUP BY account_id, week_start
        ORDER BY account_id, week_start
      `)
      .all<{ account_id: string; week_start: string; decisions: number; success_rate: number; avg_confidence: number }>();

    const accountTrajectories = new Map<string, Array<{ week: string; decisions: number; success_rate: number; avg_confidence: number }>>();
    for (const row of (trajectoryResult.results || [])) {
      if (!accountTrajectories.has(row.account_id)) {
        accountTrajectories.set(row.account_id, []);
      }
      accountTrajectories.get(row.account_id)!.push({
        week: row.week_start,
        decisions: row.decisions,
        success_rate: Math.round((row.success_rate ?? 0) * 100) / 100,
        avg_confidence: Math.round((row.avg_confidence ?? 0) * 100) / 100,
      });
    }

    const trajectoryData = {
      accounts: Array.from(accountTrajectories.entries()).map(([accountId, trajectory]) => ({
        account_id: accountId,
        name: accountMap.get(accountId) || accountId,
        trajectory,
      })),
    };

    return new Response(JSON.stringify({ data: { stats: statsData, trajectory: trajectoryData } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (e) {
    console.error('POST /v1/admin/auth error:', e);
    return err('Internal error', 500);
  }
});

// ============= ADMIN: Stats (Owner only) =============

router.get('/v1/admin/stats', async (request: IRequest, env: Env) => {
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
    if (ctx.tier !== 'owner') return err('Owner tier required', 403);

    const totalAccountsRow = await env.DB
      .prepare('SELECT COUNT(*) as count FROM accounts')
      .first<{ count: number }>();

    const activeAccountsRow = await env.DB
      .prepare("SELECT COUNT(DISTINCT account_id) as count FROM decisions WHERE created_at > datetime('now', '-30 days')")
      .first<{ count: number }>();

    const accountsResult = await env.DB
      .prepare(`
        SELECT a.id, a.name, a.email, a.tier, a.created_at,
          COUNT(d.id) as decision_count,
          MAX(d.created_at) as last_active
        FROM accounts a
        LEFT JOIN decisions d ON d.account_id = a.id
        GROUP BY a.id
        ORDER BY decision_count DESC
      `)
      .all<{ id: string; name: string; email: string; tier: string; created_at: string; decision_count: number; last_active: string | null }>();

    const totalDecisionsRow = await env.DB
      .prepare('SELECT COUNT(*) as count FROM decisions')
      .first<{ count: number }>();

    const decisions7dRow = await env.DB
      .prepare("SELECT COUNT(*) as count FROM decisions WHERE created_at > datetime('now', '-7 days')")
      .first<{ count: number }>();

    const decisions30dRow = await env.DB
      .prepare("SELECT COUNT(*) as count FROM decisions WHERE created_at > datetime('now', '-30 days')")
      .first<{ count: number }>();

    return json({
      total_accounts: totalAccountsRow?.count ?? 0,
      active_accounts: activeAccountsRow?.count ?? 0,
      accounts: (accountsResult.results || []).map(a => ({
        id: a.id,
        name: a.name,
        email: a.email,
        tier: a.tier,
        created_at: a.created_at,
        decision_count: a.decision_count,
        last_active: a.last_active,
      })),
      total_decisions: totalDecisionsRow?.count ?? 0,
      decisions_last_7d: decisions7dRow?.count ?? 0,
      decisions_last_30d: decisions30dRow?.count ?? 0,
    });
  } catch (e) {
    console.error('GET /v1/admin/stats error:', e);
    return err('Internal error', 500);
  }
});

// ============= ADMIN: Intelligence Trajectory (Owner only) =============

router.get('/v1/admin/trajectory', async (request: IRequest, env: Env) => {
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
    if (ctx.tier !== 'owner') return err('Owner tier required', 403);

    // Get all accounts for name lookup
    const accountsResult = await env.DB
      .prepare('SELECT id, name FROM accounts')
      .all<{ id: string; name: string }>();
    const accountMap = new Map<string, string>();
    for (const a of (accountsResult.results || [])) {
      accountMap.set(a.id, a.name);
    }

    // Get weekly trajectory per account
    const trajectoryResult = await env.DB
      .prepare(`
        SELECT
          account_id,
          strftime('%Y-%m-%d', created_at, 'weekday 0', '-6 days') as week_start,
          COUNT(*) as decisions,
          AVG(CASE WHEN outcome_success = 1 THEN 1.0 ELSE 0.0 END) as success_rate,
          AVG(confidence) as avg_confidence
        FROM decisions
        WHERE outcome_success IS NOT NULL
        GROUP BY account_id, week_start
        ORDER BY account_id, week_start
      `)
      .all<{ account_id: string; week_start: string; decisions: number; success_rate: number; avg_confidence: number }>();

    // Group by account
    const accountTrajectories = new Map<string, Array<{ week: string; decisions: number; success_rate: number; avg_confidence: number }>>();
    for (const row of (trajectoryResult.results || [])) {
      if (!accountTrajectories.has(row.account_id)) {
        accountTrajectories.set(row.account_id, []);
      }
      accountTrajectories.get(row.account_id)!.push({
        week: row.week_start,
        decisions: row.decisions,
        success_rate: Math.round((row.success_rate ?? 0) * 100) / 100,
        avg_confidence: Math.round((row.avg_confidence ?? 0) * 100) / 100,
      });
    }

    const accounts = Array.from(accountTrajectories.entries()).map(([accountId, trajectory]) => ({
      account_id: accountId,
      name: accountMap.get(accountId) || accountId,
      trajectory,
    }));

    return json({ accounts });
  } catch (e) {
    console.error('GET /v1/admin/trajectory error:', e);
    return err('Internal error', 500);
  }
});

// ============= TIER ARCHITECTURE: Export (Pro+) =============

router.get('/v1/export', async (request: IRequest, env: Env) => {
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
    if (ctx.tier === 'free') return err('Export requires Pro or Enterprise tier', 403);

    const decisions = await env.DB
      .prepare('SELECT * FROM decisions WHERE account_id = ? ORDER BY created_at DESC LIMIT 1000')
      .bind(ctx.account_id)
      .all();

    return new Response(JSON.stringify({ data: decisions.results || [], exported_at: new Date().toISOString() }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="marrow-export.json"',
      },
    });
  } catch (e) { return err('Internal error', 500); }
});

// ============= TIER ARCHITECTURE: Semantic Search (Pro+) =============

router.get('/v1/search', async (request: IRequest, env: Env) => {
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
    if (ctx.tier === 'free') return err('Search requires Pro or Enterprise tier', 403);

    const url = getUrl(request);
    const rawQ = url.searchParams.get('q');
    if (!rawQ) return err('q parameter required', 400);
    if (rawQ.length > 200) return err('Search query max 200 characters', 400);

    // Escape LIKE wildcards to prevent abuse
    const q = rawQ.replace(/[%_]/g, c => `\\${c}`);

    const results = await env.DB
      .prepare(`
        SELECT id, decision_type, outcome, confidence, visibility, created_at
        FROM decisions
        WHERE account_id = ? AND (context LIKE ? ESCAPE '\\' OR outcome LIKE ? ESCAPE '\\')
        ORDER BY created_at DESC
        LIMIT 50
      `)
      .bind(ctx.account_id, `%${q}%`, `%${q}%`)
      .all();

    return json(results.results || []);
  } catch (e) { return err('Internal error', 500); }
});

// ============= Aliases (map /v1/* to /* for compatibility) =============

// Alias /v1/decisions → /decisions
router.post('/v1/decisions', async (request: IRequest, env: Env) => {
  return router.handle(new Request(request.url.replace('/v1', ''), request), env);
});

router.get('/v1/decisions', async (request: IRequest, env: Env) => {
  return router.handle(new Request(request.url.replace('/v1', ''), request), env);
});

// ============= INTERNAL: Onboarding Emails =============

router.post('/v1/internal/trigger-onboarding', async (request: IRequest, env: Env) => {
  try {
    const authErr = await requireInternalKey(request, env);
    if (authErr) return authErr;

    const body = await request.json() as { account_id?: string };
    if (!body.account_id) return err('account_id required', 400);

    const account = await env.DB
      .prepare('SELECT id, email, name FROM accounts WHERE id = ? LIMIT 1')
      .bind(body.account_id)
      .first<{ id: string; email: string; name: string }>();
    if (!account) return err('Account not found', 404);

    const countRow = await env.DB
      .prepare('SELECT COUNT(*) as c FROM decisions WHERE account_id = ?')
      .bind(body.account_id)
      .first<{ c: number }>();

    const html = emailCard('Your agent just logged its first decision 🧠', `
          <p style="margin:0 0 20px;font-size:14px;color:#999;line-height:1.6;">You're in. Marrow is now learning your patterns. Come back in 7 days — you'll see your success rate starting to form.</p>
          <div style="background:#1a1a1a;padding:16px;border-radius:8px;margin:0 0 24px;">
            <p style="margin:0;font-size:32px;font-weight:700;color:#ffffff;">${countRow?.c || 1}</p>
            <p style="margin:4px 0 0;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:1px;">decision logged</p>
          </div>
          <a href="https://getmarrow.ai" style="display:inline-block;padding:10px 20px;background:#ffffff;color:#0a0a0a;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;">View your dashboard →</a>
    `);

    await sendEmail(env, account.email, 'Your agent just logged its first decision 🧠', html);
    return json({ sent: true, account_id: body.account_id });
  } catch (e) {
    console.error('[/v1/internal/trigger-onboarding]', e);
    return err('Internal error', 500);
  }
});

router.post('/v1/internal/send-checkins', async (request: IRequest, env: Env) => {
  try {
    const authErr = await requireInternalKey(request, env);
    if (authErr) return authErr;

    const rlAllowed = await checkRateLimit(env.DB, 'internal_email:send-checkins', 1, 60 * 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    // Find accounts created ~7 days ago with at least 1 decision
    const accounts = await env.DB
      .prepare(`
        SELECT a.id, a.email, a.name,
          COUNT(d.id) as decision_count,
          (SELECT decision_type FROM decisions WHERE account_id = a.id GROUP BY decision_type ORDER BY COUNT(*) DESC LIMIT 1) as top_type,
          ROUND(AVG(CASE WHEN d.outcome_success = 1 THEN 1.0 WHEN d.outcome_success = 0 THEN 0.0 ELSE NULL END) * 100) as success_rate
        FROM accounts a
        JOIN decisions d ON d.account_id = a.id
        WHERE a.created_at >= datetime('now', '-8 days')
          AND a.created_at < datetime('now', '-6 days')
          AND a.checkin_sent_at IS NULL
        GROUP BY a.id
        HAVING decision_count >= 1
      `)
      .all<{ id: string; email: string; name: string; decision_count: number; top_type: string | null; success_rate: number | null }>();

    let sentCount = 0;
    for (const acct of (accounts.results || [])) {
      const statsLines: string[] = [];
      statsLines.push(`<p style="margin:0 0 4px;font-size:14px;color:#999;">📊 <strong style="color:#fff;">${acct.decision_count}</strong> decisions logged</p>`);
      if (acct.top_type) statsLines.push(`<p style="margin:0 0 4px;font-size:14px;color:#999;">🏷️ Top type: <strong style="color:#fff;">${escapeHtml(acct.top_type)}</strong></p>`);
      if (acct.success_rate !== null) statsLines.push(`<p style="margin:0 0 4px;font-size:14px;color:#999;">✅ Success rate: <strong style="color:#fff;">${acct.success_rate}%</strong></p>`);

      const html = emailCard("7 days in — here's what Marrow learned about you", `
          <p style="margin:0 0 20px;font-size:14px;color:#999;line-height:1.6;">Here's your agent's progress so far:</p>
          <div style="background:#1a1a1a;padding:16px;border-radius:8px;margin:0 0 24px;">
            ${statsLines.join('\n            ')}
          </div>
          <a href="https://getmarrow.ai" style="display:inline-block;padding:10px 20px;background:#ffffff;color:#0a0a0a;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;">Keep going — your agent is just getting started →</a>
      `);

      const sent = await sendEmail(env, acct.email, "7 days in — here's what Marrow learned about you", html);
      if (sent) {
        sentCount++;
        await env.DB.prepare('UPDATE accounts SET checkin_sent_at = ? WHERE id = ?').bind(new Date().toISOString(), acct.id).run().catch(() => {});
      }
    }

    return json({ sent: sentCount, total_eligible: (accounts.results || []).length });
  } catch (e) {
    console.error('[/v1/internal/send-checkins]', e);
    return err('Internal error', 500);
  }
});

// ============= INTERNAL: Day 3 Nudge Email =============

router.post('/v1/internal/send-day3-nudge', async (request: IRequest, env: Env) => {
  try {
    const authErr = await requireInternalKey(request, env);
    if (authErr) return authErr;

    const rlAllowed2 = await checkRateLimit(env.DB, 'internal_email:send-day3-nudge', 1, 60 * 60 * 1000);
    if (!rlAllowed2) return err('Rate limited', 429);

    // Find accounts with no first_think_at, created >3 days ago, not already nudged
    const eligible = await env.DB
      .prepare(`
        SELECT id, email FROM accounts
        WHERE first_think_at IS NULL
          AND created_at < datetime('now', '-3 days')
          AND day3_nudge_sent_at IS NULL
          AND email IS NOT NULL
          AND email != ''
      `)
      .all<{ id: string; email: string }>();

    const eligibleAccounts = eligible.results || [];
    let sentCount = 0;

    for (const acct of eligibleAccounts) {
      const nudgeHtml = emailCard('Your agent still doesn\'t know anything about you.', `
        <p style="margin:0 0 20px;font-size:14px;color:#999999;line-height:1.6;">Every session your agent starts cold. It'll keep doing that until you give it something to work with.</p>
        <p style="margin:0 0 20px;font-size:14px;color:#999999;line-height:1.6;">One call. Thirty seconds.</p>
        <pre style="font-family:'Courier New',Courier,monospace;background:#111111;color:#e5e5e5;border:1px solid #222222;padding:16px;border-radius:6px;font-size:13px;display:block;margin:0 0 20px;white-space:pre-wrap;"><code>await marrow.think({ action: 'first test', type: 'general' })
await marrow.commit({ success: true, outcome: 'done' })</code></pre>
        <p style="margin:0 0 20px;font-size:14px;color:#999999;line-height:1.6;">That's the whole quickstart.</p>
        <a href="https://getmarrow.ai/docs/quickstart" style="display:inline-block;padding:10px 24px;background:#ffffff;color:#0a0a0a;text-decoration:none;border-radius:0px;font-size:13px;font-weight:600;">Jump to quickstart →</a>
      `);

      const sent = await sendEmail(env, acct.email, 'Your agent still doesn\'t know anything about you.', nudgeHtml);
      if (sent) {
        await env.DB.prepare('UPDATE accounts SET day3_nudge_sent_at = ? WHERE id = ?')
          .bind(new Date().toISOString(), acct.id).run();
        sentCount++;
      }
    }

    return json({ sent: sentCount, eligible: eligibleAccounts.length });
  } catch (e) {
    console.error('[/v1/internal/send-day3-nudge]', e);
    return err('Internal error', 500);
  }
});

// ============= Workflow Registry (Tier 21) =============

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
// ============= V5 Phase 1: Fleet Primitives =============

// ---------- Agent Registry ----------

// POST /v1/agents — register a new agent
router.post('/v1/agents', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const rlAllowed = await checkRateLimit(env.DB, `agents_create:${ctx.account_id}`, 10, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const body = await request.json?.() as Record<string, unknown> | undefined;
    if (!body?.name || typeof body.name !== 'string') return err('name is required', 400);

    const agentSvc = new AgentService(env.DB);
    const agent = await agentSvc.registerAgent(ctx.account_id, {
      name: body.name as string,
      role: typeof body.role === 'string' ? body.role : undefined,
      specialty: typeof body.specialty === 'string' ? body.specialty : undefined,
      avatar_url: typeof body.avatar_url === 'string' ? body.avatar_url : undefined,
    });

    return json(agent, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg.includes('UNIQUE')) return err('Agent name already exists in this account', 409);
    return err(msg, 400);
  }
});

// GET /v1/agents — list fleet agents
router.get('/v1/agents', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const url = getUrl(request);
    const status = url.searchParams.get('status') || 'active';
    const limit = parseInt(url.searchParams.get('limit') || '50') || 50;

    const agentSvc = new AgentService(env.DB);
    const agents = await agentSvc.listAgents(ctx.account_id, { status, limit });

    return json({ agents });
  } catch (e: unknown) {
    console.error('GET /v1/agents error:', e);
    return err('Internal server error', 500);
  }
});

// GET /v1/agents/:id — agent card with stats
router.get('/v1/agents/:id', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const agentId = (request as any).params.id;
    if (!agentId) return err('Agent ID required', 400);

    const agentSvc = new AgentService(env.DB);
    const agent = await agentSvc.getAgent(agentId, ctx.account_id);
    if (!agent) return err('Agent not found', 404);

    const stats = await agentSvc.getAgentStats(agentId, ctx.account_id);

    return json({ ...agent, stats });
  } catch (e: unknown) {
    console.error('GET /v1/agents/:id error:', e);
    return err('Internal server error', 500);
  }
});

// PATCH /v1/agents/:id — update agent metadata
router.patch('/v1/agents/:id', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const agentId = (request as any).params.id;
    if (!agentId) return err('Agent ID required', 400);

    const body = await request.json?.() as Record<string, unknown> | undefined;
    if (!body) return err('Request body required', 400);

    const agentSvc = new AgentService(env.DB);
    const updated = await agentSvc.updateAgent(agentId, ctx.account_id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      role: typeof body.role === 'string' ? body.role : undefined,
      specialty: typeof body.specialty === 'string' ? body.specialty : undefined,
      status: typeof body.status === 'string' ? body.status : undefined,
      avatar_url: typeof body.avatar_url === 'string' ? body.avatar_url : undefined,
    });

    if (!updated) return err('Agent not found', 404);
    return json(updated);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return err(msg, 400);
  }
});

// DELETE /v1/agents/:id — archive agent (soft delete)
router.delete('/v1/agents/:id', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const agentId = (request as any).params.id;
    if (!agentId) return err('Agent ID required', 400);

    const agentSvc = new AgentService(env.DB);
    const archived = await agentSvc.archiveAgent(agentId, ctx.account_id);

    if (!archived) return err('Agent not found or already archived', 404);
    return json({ archived: true });
  } catch (e: unknown) {
    console.error('DELETE /v1/agents/:id error:', e);
    return err('Internal server error', 500);
  }
});

// ---------- Organization Endpoints ----------

// POST /v1/orgs — create organization
router.post('/v1/orgs', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const rlAllowed = await checkRateLimit(env.DB, `orgs_create:${ctx.account_id}`, 5, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const body = await request.json?.() as Record<string, unknown> | undefined;
    if (!body?.name || typeof body.name !== 'string') return err('name is required', 400);

    const orgSvc = new OrgService(env.DB);
    const org = await orgSvc.createOrg(
      body.name as string,
      ctx.account_id,
      typeof body.industry === 'string' ? body.industry : undefined,
    );

    return json({ id: org.id, name: org.name, slug: org.slug }, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return err(msg, 400);
  }
});

// GET /v1/orgs/:id — org details + members
router.get('/v1/orgs/:id', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const orgId = (request as any).params.id;
    const orgSvc = new OrgService(env.DB);

    // Verify membership
    const isMember = await orgSvc.isOrgMember(orgId, ctx.account_id);
    if (!isMember) return err('Not a member of this organization', 403);

    const result = await orgSvc.getOrgWithMembers(orgId);
    if (!result) return err('Organization not found', 404);

    return json(result);
  } catch (e: unknown) {
    console.error('GET /v1/orgs/:id error:', e);
    return err('Internal server error', 500);
  }
});

// POST /v1/orgs/:id/members — invite a member
router.post('/v1/orgs/:id/members', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const orgId = (request as any).params.id;
    const orgSvc = new OrgService(env.DB);

    // Require admin+ to invite
    const hasRole = await orgSvc.hasMinRole(orgId, ctx.account_id, 'admin');
    if (!hasRole) return err('Admin or owner role required to invite members', 403);

    const body = await request.json?.() as Record<string, unknown> | undefined;
    if (!body?.account_id || typeof body.account_id !== 'string') return err('account_id is required', 400);

    const role = (typeof body.role === 'string' ? body.role : 'viewer') as any;
    const member = await orgSvc.addMember(orgId, body.account_id as string, role);

    return json(member, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return err(msg, 400);
  }
});

// DELETE /v1/orgs/:id/members/:memberId — remove member
router.delete('/v1/orgs/:id/members/:memberId', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const orgId = (request as any).params.id;
    const memberId = (request as any).params.memberId;
    const orgSvc = new OrgService(env.DB);

    const hasRole = await orgSvc.hasMinRole(orgId, ctx.account_id, 'admin');
    if (!hasRole) return err('Admin or owner role required', 403);

    const removed = await orgSvc.removeMember(orgId, memberId);
    if (!removed) return err('Member not found', 404);

    return json({ removed: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return err(msg, 400);
  }
});

// PATCH /v1/orgs/:id/members/:memberId — update member role
router.patch('/v1/orgs/:id/members/:memberId', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const orgId = (request as any).params.id;
    const memberId = (request as any).params.memberId;
    const orgSvc = new OrgService(env.DB);

    const hasRole = await orgSvc.hasMinRole(orgId, ctx.account_id, 'owner');
    if (!hasRole) return err('Owner role required to change member roles', 403);

    const body = await request.json?.() as Record<string, unknown> | undefined;
    if (!body?.role || typeof body.role !== 'string') return err('role is required', 400);

    const updated = await orgSvc.updateMemberRole(orgId, memberId, body.role as any);
    if (!updated) return err('Member not found', 404);

    return json({ updated: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return err(msg, 400);
  }
});

// GET /v1/templates/learned — learned templates from pattern clusters (Phase 2)
// No auth required — public browsing of discovered templates
// NOTE: must be defined BEFORE /v1/templates (line 4498) to avoid :slug catch
router.get('/v1/templates/learned', async (request: IRequest, env: Env) => {
  try {
    const url = getUrl(request);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20') || 20, 100);
    const patterns = new PatternsService(env.DB, env.AI);

    // Phase 3: If table empty, sync-learn on first access
    const countRow = await env.DB.prepare('SELECT COUNT(*) as c FROM learned_templates').first<{ c: number }>();
    const isEmpty = (countRow?.c || 0) === 0;
    if (isEmpty) {
      await patterns.learnTemplates().catch((e: unknown) => console.error('[sync-learn]', e instanceof Error ? e.message : e));
    }

    const templates = await patterns.getLearnedTemplates(limit);
    return json({ templates, refreshed: isEmpty });
  } catch (e: unknown) {
    console.error('GET /v1/templates/learned error:', e instanceof Error ? e.message : e);
    return err('Internal server error', 500);
  }
});

// ---------- Workflow Template Marketplace ----------

// GET /v1/templates — list templates
router.get('/v1/templates', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;

    const url = getUrl(request);
    const tplSvc = new TemplatesService(env.DB);
    const templates = await tplSvc.listTemplates({
      industry: url.searchParams.get('industry') || undefined,
      category: url.searchParams.get('category') || undefined,
      search: url.searchParams.get('search') || undefined,
      limit: parseInt(url.searchParams.get('limit') || '20') || 20,
    });

    return json({ templates });
  } catch (e: unknown) {
    console.error('GET /v1/templates error:', e);
    return err('Internal server error', 500);
  }
});

// GET /v1/templates/:slug — template details
router.get('/v1/templates/:slug', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;

    const slug = (request as any).params.slug;
    const tplSvc = new TemplatesService(env.DB);
    const template = await tplSvc.getTemplate(slug);

    if (!template) return err('Template not found', 404);
    return json(template);
  } catch (e: unknown) {
    console.error('GET /v1/templates/:slug error:', e);
    return err('Internal server error', 500);
  }
});

// POST /v1/templates/:slug/install — install template as workflow
router.post('/v1/templates/:slug/install', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const rlAllowed = await checkRateLimit(env.DB, `tpl_install:${ctx.account_id}`, 10, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const slug = (request as any).params.slug;
    const tplSvc = new TemplatesService(env.DB);
    const result = await tplSvc.installTemplate(slug, ctx.account_id);

    return json(result, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return err(msg, 400);
  }
});

// POST /v1/templates — publish a custom template (admin/team+)
router.post('/v1/templates', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    // M2 fix: Only non-free tiers can publish templates
    if (ctx.tier === 'free') return err('Template publishing requires a paid plan', 403);

    const rlAllowed = await checkRateLimit(env.DB, `tpl_publish:${ctx.account_id}`, 5, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const body = await request.json?.() as Record<string, unknown> | undefined;
    if (!body?.name || !body?.steps) return err('name and steps are required', 400);

    const tplSvc = new TemplatesService(env.DB);
    const template = await tplSvc.publishTemplate({
      name: body.name as string,
      description: typeof body.description === 'string' ? body.description : undefined,
      industry: typeof body.industry === 'string' ? body.industry : undefined,
      category: typeof body.category === 'string' ? body.category : undefined,
      steps: body.steps as unknown[],
      tags: Array.isArray(body.tags) ? body.tags : undefined,
    }, ctx.account_id);

    return json(template, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return err(msg, 400);
  }
});

// GET /v1/org/patterns — cross-agent team patterns (Phase 3)
// Tier-gated: Team/Enterprise only. Free/Pro get 403.
router.get('/v1/org/patterns', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    if (ctx.tier !== 'enterprise' && ctx.tier !== 'owner') {
      return err('Team patterns require Enterprise tier', 403);
    }

    const orgSvc = new OrgService(env.DB);
    const org = await orgSvc.getOrgForAccount(ctx.account_id);
    if (!org) return err('No organization found for this account', 404);

    const url = getUrl(request);
    const decisionType = url.searchParams.get('decision_type') || 'all';
    const patterns = new PatternsService(env.DB, env.AI);
    const result = await patterns.discoverOrgPatterns(org.id, decisionType);

    return json({ org_id: org.id, org_name: org.name, patterns: result });
  } catch (e: unknown) {
    console.error('GET /v1/org/patterns error:', e instanceof Error ? e.message : e);
    return err('Internal server error', 500);
  }
});

// ---------- Fleet Dashboard ----------

// GET /v1/fleet — fleet status
// ============= Memories =============

router.get('/v1/memories/retrieve', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const url = getUrl(request);
    const statusParam = url.searchParams.get('status');
    const query = url.searchParams.get('q') || '';
    const accessAgentIds = getAccessAgentIds(ctx);
    const memoryService = new MemoryService(env.DB);
    const result = await memoryService.retrieveMemories(ctx.account_id, query, {
      limit: Number(url.searchParams.get('limit') || 20),
      includeStale: url.searchParams.get('includeStale') === 'true',
      from: url.searchParams.get('from') || undefined,
      to: url.searchParams.get('to') || undefined,
      tags: url.searchParams.get('tags') || undefined,
      source: url.searchParams.get('source') || undefined,
      status: statusParam === 'active' || statusParam === 'outdated' || statusParam === 'superseded' || statusParam === 'deleted'
        ? statusParam
        : undefined,
      shared: url.searchParams.get('shared') === null
        ? undefined
        : url.searchParams.get('shared') === 'true',
      agentId: accessAgentIds?.[0],
      agentIds: accessAgentIds,
    });

    return json(result);
  } catch (e: unknown) {
    console.error('GET /v1/memories/retrieve error:', e);
    return err('Internal server error', 500);
  }
});

router.get('/v1/memories/export', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const url = getUrl(request);
    const statusParam = url.searchParams.get('status');
    const tags = (url.searchParams.get('tags') || '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);

    const memoryService = new MemoryService(env.DB);
    const result = await memoryService.exportMemories(ctx.account_id, {
      format: url.searchParams.get('format') === 'csv' ? 'csv' : 'json',
      status: statusParam === 'all' || statusParam === 'active' || statusParam === 'outdated' || statusParam === 'superseded' || statusParam === 'deleted'
        ? statusParam as 'all' | 'active' | 'outdated' | 'superseded' | 'deleted'
        : undefined,
      tags,
      agentId: getAccessAgentIds(ctx)?.[0],
      agentIds: getAccessAgentIds(ctx),
    });

    return json(result);
  } catch (e: unknown) {
    console.error('GET /v1/memories/export error:', e);
    return err('Internal server error', 500);
  }
});

router.post('/v1/memories/import', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    if (isAgentBoundContext(ctx)) return err('Agent-bound tokens cannot import memories', 403);

    const body = await request.json() as {
      memories?: Array<{ text?: string; source?: string; tags?: string[]; sharedWith?: string[]; shared_with?: string[] }>;
      mode?: 'merge' | 'replace';
    };

    const memoryService = new MemoryService(env.DB);
    const result = await memoryService.importMemories(
      ctx.account_id,
      (body.memories || []).map((memory) => ({
        text: memory.text,
        source: memory.source,
        tags: memory.tags,
        sharedWith: memory.sharedWith || memory.shared_with,
      })),
      body.mode === 'replace' ? 'replace' : 'merge'
    );

    return json(result);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Internal server error';
    if (message.includes('Import validation failed')) return err(message, 400);
    console.error('POST /v1/memories/import error:', e);
    return err('Internal server error', 500);
  }
});

router.get('/v1/memories', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const url = getUrl(request);
    const statusParam = url.searchParams.get('status');
    const memoryService = new MemoryService(env.DB);
    const memories = await memoryService.listMemories(ctx.account_id, {
      status: statusParam === 'active' || statusParam === 'outdated' || statusParam === 'superseded' || statusParam === 'deleted'
        ? statusParam
        : undefined,
      query: url.searchParams.get('query') || undefined,
      includeDeleted: url.searchParams.get('includeDeleted') === 'true',
      limit: Number(url.searchParams.get('limit') || 20),
      agentId: getAccessAgentIds(ctx)?.[0] || url.searchParams.get('agent_id') || undefined,
      agentIds: getAccessAgentIds(ctx),
    });

    return json({ memories, count: memories.length });
  } catch (e: unknown) {
    console.error('GET /v1/memories error:', e);
    return err('Internal server error', 500);
  }
});

router.get('/v1/memories/:id', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const memoryService = new MemoryService(env.DB);
    const memory = await memoryService.getMemory(String(request.params?.id), ctx.account_id, {
      includeDeleted: getUrl(request).searchParams.get('includeDeleted') === 'true',
      accessAgentIds: getAccessAgentIds(ctx),
    });

    if (!memory) {
      return err('Memory not found', 404, { id: String(request.params?.id) });
    }

    return json({ memory });
  } catch (e: unknown) {
    console.error('GET /v1/memories/:id error:', e);
    return err('Internal server error', 500);
  }
});

router.patch('/v1/memories/:id', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const body = await request.json() as { text?: string; source?: string | null; tags?: string[]; actor?: string; note?: string };

    const memoryService = new MemoryService(env.DB);
    const memory = await memoryService.updateMemory(String(request.params?.id), ctx.account_id, body, {
      accessAgentIds: getAccessAgentIds(ctx),
    });
    if (!memory) {
      return err('Memory not found', 404, { id: String(request.params?.id) });
    }

    return json({ memory });
  } catch (e: unknown) {
    console.error('PATCH /v1/memories/:id error:', e);
    const message = e instanceof Error ? e.message : 'Internal server error';
    if (message.includes('required')) return err(message, 400);
    return err('Internal server error', 500);
  }
});

router.delete('/v1/memories/:id', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const body = await request.json().catch(() => ({})) as { actor?: string; note?: string };

    const memoryService = new MemoryService(env.DB);
    const memory = await memoryService.deleteMemory(String(request.params?.id), ctx.account_id, body, {
      accessAgentIds: getAccessAgentIds(ctx),
    });
    if (!memory) {
      return err('Memory not found', 404, { id: String(request.params?.id) });
    }

    return json({ memory });
  } catch (e: unknown) {
    console.error('DELETE /v1/memories/:id error:', e);
    return err('Internal server error', 500);
  }
});

router.post('/v1/memories/:id/outdated', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const body = await request.json().catch(() => ({})) as { actor?: string; note?: string };

    const memoryService = new MemoryService(env.DB);
    const memory = await memoryService.markOutdated(String(request.params?.id), ctx.account_id, body, {
      accessAgentIds: getAccessAgentIds(ctx),
    });
    if (!memory) {
      return err('Memory not found', 404, { id: String(request.params?.id) });
    }

    return json({ memory });
  } catch (e: unknown) {
    console.error('POST /v1/memories/:id/outdated error:', e);
    return err('Internal server error', 500);
  }
});

router.post('/v1/memories/:id/supersede', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const body = await request.json() as { text?: string; source?: string; tags?: string[]; actor?: string; note?: string };
    if (!body.text || !String(body.text).trim()) {
      return err('Replacement memory text is required', 400);
    }

    const memoryService = new MemoryService(env.DB);
    const result = await memoryService.supersedeMemory(String(request.params?.id), ctx.account_id, {
      text: body.text,
      source: body.source,
      tags: body.tags,
      actor: body.actor,
      note: body.note,
    }, {
      accessAgentIds: getAccessAgentIds(ctx),
    });
    if (!result) {
      return err('Memory not found', 404, { id: String(request.params?.id) });
    }

    return json(result);
  } catch (e: unknown) {
    console.error('POST /v1/memories/:id/supersede error:', e);
    const message = e instanceof Error ? e.message : 'Internal server error';
    if (message.includes('required')) return err(message, 400);
    return err('Internal server error', 500);
  }
});

router.post('/v1/memories/:id/share', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    if (isAgentBoundContext(ctx)) return err('Agent-bound tokens cannot share memories', 403);

    const body = await request.json().catch(() => ({})) as { agent_ids?: string[]; agentIds?: string[]; actor?: string };

    const memoryService = new MemoryService(env.DB);
    const memory = await memoryService.shareMemory(
      String(request.params?.id),
      ctx.account_id,
      body.agent_ids || body.agentIds || [],
      body.actor
    );
    if (!memory) {
      return err('Memory not found', 404, { id: String(request.params?.id) });
    }

    return json({ memory });
  } catch (e: unknown) {
    console.error('POST /v1/memories/:id/share error:', e);
    return err('Internal server error', 500);
  }
});

router.get('/v1/fleet', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const rlAllowed = await checkRateLimit(env.DB, `fleet:${ctx.account_id}`, 60, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const fleetSvc = new FleetService(env.DB);
    const status = await fleetSvc.getFleetStatus(ctx.account_id);

    return json(status);
  } catch (e: unknown) {
    console.error('GET /v1/fleet error:', e);
    return err('Internal server error', 500);
  }
});

// GET /v1/fleet/stream — SSE stream of fleet events
router.get('/v1/fleet/stream', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    // M3 fix: Rate limit SSE stream
    const rlAllowed = await checkRateLimit(env.DB, `fleet_stream:${ctx.account_id}`, 120, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const url = getUrl(request);
    const since = url.searchParams.get('since') || new Date(Date.now() - 60000).toISOString();

    const fleetSvc = new FleetService(env.DB);
    const events = await fleetSvc.getFleetEvents(ctx.account_id, since);

    // SSE response
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`));
        }
        controller.close();
      },
    });

    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (e: unknown) {
    console.error('GET /v1/fleet/stream error:', e);
    return err('Internal server error', 500);
  }
});

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
