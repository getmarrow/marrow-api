/**
 * Marrow API — Complete 20-Tier Platform
 * Cloudflare Workers + D1 + itty-router
 */
import { Router, IRequest } from 'itty-router';
import { Env, RequestContext, ApiResponse } from './types';
import { AuthService } from './services/auth.service';
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
import type { VelocityMetric } from './services/velocity.service';
import { checkRateLimit } from './utils/rate-limit';
import { PatternEngine } from './pattern-engine';
import { autoLogDecision } from './middleware/auto-logger';

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

// ============= Router =============

const router = Router();

// ============= Auth Helper =============
async function requireAuth(request: IRequest, env: Env): Promise<RequestContext | Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    return err('Unauthorized', 401);
  }

  try {
    const authService = new AuthService(env.DB);
    const ctx = await authService.validateToken(authHeader);
    if (!ctx) {
      return err('Unauthorized', 401);
    }
    return ctx;
  } catch (error) {
    return err('Auth error', 500);
  }
}

// ---------- Internal Auth Helper ----------
async function requireInternalKey(request: IRequest, env: Env): Promise<Response | null> {
  const key = request.headers.get('X-Internal-Key');
  if (!env.INTERNAL_KEY || !key) {
    return err('Unauthorized', 401);
  }
  // H1 fix: timing-safe compare via HMAC to prevent timing attacks
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(key);
  const bBytes = encoder.encode(env.INTERNAL_KEY);
  if (aBytes.length !== bBytes.length) return err('Unauthorized', 401);
  const aKey = await crypto.subtle.importKey('raw', aBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bKey = await crypto.subtle.importKey('raw', bBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const msg = encoder.encode('marrow-internal');
  const aHmac = await crypto.subtle.sign('HMAC', aKey, msg);
  const bHmac = await crypto.subtle.sign('HMAC', bKey, msg);
  const aHex = Array.from(new Uint8Array(aHmac)).map(b => b.toString(16).padStart(2, '0')).join('');
  const bHex = Array.from(new Uint8Array(bHmac)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (aHex !== bHex) return err('Unauthorized', 401);
  return null;
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
      body: JSON.stringify({ from: 'Marrow <noreply@getmarrow.ai>', to, subject, html }),
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

// ============= KEY REQUEST / VERIFY (Public signup flow) =============

router.post('/v1/keys/request', async (request: IRequest, env: Env) => {
  try {
    const body = await request.json() as { email?: string };
    const email = (body?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return err('Invalid email', 400);
    }

    // M1 fix: IP-based rate limit — 10 OTP requests per IP per hour
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const ipAllowed = await checkRateLimit(env.DB, `otp_request_ip:${ip}`, 10, 60 * 60 * 1000);
    if (!ipAllowed) return err('Too many requests. Try again later.', 429);

    const otpService = new OtpService(env.DB);

    // Rate limit: max 5 requests per email per hour
    const allowed = await otpService.checkRateLimit(email);
    if (!allowed) return err('Too many requests. Try again later.', 429);

    const otp = otpService.generateOtp();
    await otpService.storeOtp(email, otp);

    const isDev = env.ENVIRONMENT === 'development';

    if (!env.RESEND_API_KEY) {
      if (isDev) console.log(`[OTP DEBUG] email=${email} otp=${otp}`);
      return new Response(
        JSON.stringify({ sent: true, ...(isDev ? { debug_otp: otp } : {}) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Send via Resend API
    const emailText = `Your verification code is: ${otp}\n\nExpires in 10 minutes. Don't share this code.\n\ngetmarrow.ai`;
    const emailHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#111111;border-radius:12px;border:1px solid #222222;overflow:hidden;">
        <tr><td style="padding:32px 32px 24px;">
          <p style="margin:0 0 4px;font-size:18px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Marrow API Key</p>
          <p style="margin:0 0 28px;font-size:14px;color:#666666;">Your verification code</p>
          <p style="margin:0 0 28px;font-size:48px;font-weight:700;color:#ffffff;letter-spacing:8px;font-family:'Courier New',Courier,monospace;">${otp}</p>
          <p style="margin:0 0 24px;font-size:13px;color:#555555;line-height:1.5;">Expires in 10 minutes. Don't share this code.</p>
          <hr style="border:none;border-top:1px solid #222222;margin:0 0 20px;">
          <p style="margin:0;font-size:13px;color:#444444;">getmarrow.ai</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Marrow <noreply@getmarrow.ai>',
        to: email,
        subject: 'Your Marrow API key verification code',
        text: emailText,
        html: emailHtml,
      }),
    });

    if (!resendRes.ok) {
      const resendErr = await resendRes.text();
      console.error(`[Resend error] ${resendErr}`);
      return err('Failed to send email', 500);
    }

    return new Response(JSON.stringify({ sent: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[/v1/keys/request]', e);
    return err('Internal error', 500);
  }
});

router.post('/v1/keys/verify', async (request: IRequest, env: Env) => {
  try {
    const body = await request.json() as { email?: string; otp?: string };
    const email = (body?.email || '').trim().toLowerCase();
    const otp = (body?.otp || '').trim();

    if (!email || !otp) {
      return err('email and otp are required', 400);
    }

    // H1 fix: Rate limit OTP verification — 5 failed attempts per email per 10 minutes
    const verifyAllowed = await checkRateLimit(env.DB, `otp_verify:${email}`, 5, 10 * 60 * 1000);
    if (!verifyAllowed) {
      return err('Too many verification attempts. Try again later.', 429);
    }

    const otpService = new OtpService(env.DB);
    const valid = await otpService.verifyOtp(email, otp);
    if (!valid) {
      return err('Invalid or expired OTP', 401);
    }

    const authService = new AuthService(env.DB);

    // Find or create account
    let account = await env.DB
      .prepare('SELECT id FROM accounts WHERE email = ? LIMIT 1')
      .bind(email)
      .first<{ id: string }>();

    let accountId: string;
    if (!account) {
      const created = await authService.createAccount(email /* name */, email /* email */, 'free');
      accountId = created.id;
    } else {
      accountId = account.id;
    }

    // Get or create API key
    let keyRow = await env.DB
      .prepare(`SELECT ak.id, ak.key_hash FROM api_keys ak WHERE ak.account_id = ? AND ak.status = 'active' LIMIT 1`)
      .bind(accountId)
      .first<{ id: string; key_hash: string }>();

    // Revoke any existing active keys before issuing new one
    if (keyRow) {
      await env.DB
        .prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE account_id = ? AND status = 'active'")
        .bind(new Date().toISOString(), accountId)
        .run();
    }

    const created = await authService.createApiKey(accountId);
    const apiKey = created.key;

    // Send welcome email (non-blocking)
    const welcomeHtml = emailCard('Your Marrow key is live.', `
          <p style="margin:0 0 20px;font-size:14px;color:#999999;line-height:1.6;">Your key is active. The faster you log your first decision, the faster the hive starts working for you.</p>
          <pre style="font-family:'Courier New',Courier,monospace;background:#111111;color:#e5e5e5;border:1px solid #222222;padding:16px;border-radius:6px;font-size:13px;display:block;margin:0 0 20px;white-space:pre-wrap;word-break:break-all;"><code>import MarrowClient from '@getmarrow/sdk'

const marrow = new MarrowClient('YOUR_API_KEY')

const { decisionId } = await marrow.think({
  action: 'your first decision',
  type: 'general'
})

await marrow.commit({
  success: true,
  outcome: 'it works'
})</code></pre>
          <p style="margin:0 0 20px;font-size:14px;color:#999999;line-height:1.6;">That's it. You just logged a decision. Marrow will start building a model from here.</p>
          <p style="margin:0 0 20px;font-size:14px;color:#999;">Retrieve your key securely at <a href="https://getmarrow.ai/dashboard" style="color:#ffffff;font-weight:600;">getmarrow.ai/dashboard</a></p>
          <a href="https://getmarrow.ai/docs" style="display:inline-block;padding:10px 24px;background:#ffffff;color:#0a0a0a;text-decoration:none;border-radius:0px;font-size:13px;font-weight:600;">Read the docs →</a>
    `);
    sendEmail(env, email, 'Your Marrow key is live. Make your first decision.', welcomeHtml).catch(() => {});

    return new Response(JSON.stringify({ apiKey }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[/v1/keys/verify]', e);
    return err('Internal error', 500);
  }
});

// ============= TIER 1: AUTH =============

router.post('/v1/auth/accounts', async (request: IRequest, env: Env) => {
  try {
    // Rate limit: max 3 account creations per IP per hour
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const allowed = await checkRateLimit(env.DB, `acct_create:${ip}`, 3, 60 * 60 * 1000);
    if (!allowed) return err('Too many account creation requests. Try again later.', 429);

    const body = await request.json() as Record<string, unknown>;
    const authService = new AuthService(env.DB);
    const account = await authService.createAccount(
      String(body.name || ''), String(body.email || ''), 'free'  // H2 fix: always free, never trust client-supplied tier
    );
    const { key, keyId } = await authService.createApiKey(account.id);
    return json({ account, api_key: key, key_id: keyId }, 201);
  } catch (e: unknown) { return err('Internal error'); }
});

router.get('/v1/auth/account', async (request: IRequest, env: Env) => {
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
    const authService = new AuthService(env.DB);
    const account = await authService.getAccount(ctx.account_id);
    if (!account) return err('Not found', 404);
    return json(account);
  } catch (e: unknown) { return err('Internal error'); }
});

router.post('/v1/auth/keys/revoke', async (request: IRequest, env: Env) => {
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
    const authService = new AuthService(env.DB);
    await authService.revokeApiKey(String(body.key_id), ctx.account_id);
    return json({ revoked: true });
  } catch (e: unknown) { return err('Internal error'); }
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
    const decisionService = new DecisionService(env.DB);
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
    const decisionService = new DecisionService(env.DB);
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
    const patterns = new PatternsService(env.DB);
    const suggestions = await patterns.predictSimilarDecisions({ type: decisionType }, decisionType, 5);
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
    const decisionService = new DecisionService(env.DB);
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
    const patterns = new PatternsService(env.DB);
    const similar = await patterns.predictSimilarDecisions(
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
    const patterns = new PatternsService(env.DB);
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
    const patterns = new PatternsService(env.DB);
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
    const patterns = new PatternsService(env.DB);
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
      const decisionService = new DecisionService(env.DB);
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

// ============= AGENT API: SINGLE-CALL THINK (ALL 20 TIERS) =============

/**
 * Auto-snapshot helper: if account has 10+ decisions since last snapshot, create one (T14).
 */
async function autoSnapshotIfNeeded(db: D1Database, accountId: string, encryptionKey?: string): Promise<void> {
  try {
    const snapshotService = new SnapshotService(db, encryptionKey);
    // M1: Rate limit — max 1 auto-snapshot per hour per account
    const lastSnapshotRow = await db
      .prepare('SELECT created_at FROM snapshots WHERE account_id = ? ORDER BY created_at DESC LIMIT 1')
      .bind(accountId)
      .first<{ created_at: string }>();
    if (lastSnapshotRow?.created_at) {
      const lastTime = new Date(lastSnapshotRow.created_at).getTime();
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      if (lastTime > oneHourAgo) return; // Too recent, skip
    }

    const snapshots = await snapshotService.listSnapshots(accountId, 1);
    const lastSnapshotTime = snapshots.length > 0 ? snapshots[0].created_at : null;

    let decisionsSinceSnapshot = 0;
    if (lastSnapshotTime) {
      const row = await db
        .prepare('SELECT COUNT(*) as c FROM decisions WHERE account_id = ? AND created_at > ?')
        .bind(accountId, lastSnapshotTime)
        .first<{ c: number }>();
      decisionsSinceSnapshot = row?.c || 0;
    } else {
      const row = await db
        .prepare('SELECT COUNT(*) as c FROM decisions WHERE account_id = ?')
        .bind(accountId)
        .first<{ c: number }>();
      decisionsSinceSnapshot = row?.c || 0;
    }

    if (decisionsSinceSnapshot >= 10) {
      await snapshotService.createSnapshot(accountId, `auto-snapshot-${new Date().toISOString()}`, ['auto']);
    }
  } catch (_e) {
    // T14 auto-snapshot is best-effort — never block the response
  }
}

router.post('/v1/agent/think', async (request: IRequest, env: Env) => {
  try {
    // T1: Auth
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    // Read session ID early for auto-logger and downstream use
    const reqSessionId = request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null;

    // Resolve agent_id: PATH 2 header > PATH 1 auth-derived
    let reqAgentId: string | null = ctx.agent_id || null;
    const headerAgentId = request.headers.get('X-Marrow-Agent-Id');
    if (headerAgentId && /^[a-f0-9-]{36}$/.test(headerAgentId)) {
      // Validate agent belongs to this account
      const agentCheck = await env.DB
        .prepare("SELECT id FROM agents WHERE id = ? AND account_id = ? AND status != 'archived' LIMIT 1")
        .bind(headerAgentId, ctx.account_id)
        .first<{ id: string }>();
      if (agentCheck) reqAgentId = agentCheck.id;
    }

    // Auto-log this API call as a decision (non-blocking, fire-and-forget)
    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: request.url.split(new URL(request.url).origin).pop() || request.url,
      statusCode: 200,
      tier: ctx.tier,
      sessionId: reqSessionId,
    }).catch(() => {});

    const body = await request.json() as Record<string, unknown>;
    if (!body.action || typeof body.action !== 'string' || body.action.length > 1000) {
      return err('action is required and must be under 1000 characters', 400);
    }

    const action = String(body.action);
    const type = String(body.type || 'general');
    if (type.length > 50) return err('type max 50 characters', 400);
    let visibility = body.visibility ? String(body.visibility) as 'private' | 'shared' | 'hive' | 'team' : undefined;

    // Gap 4: Detect if PII was stripped
    const piiService = new PiiService();
    const strippedAction = piiService.stripString(action);
    const sanitized = strippedAction !== action;

    // Extract previous session fields for auto-commit
    const previousDecisionId = body.previous_decision_id ? String(body.previous_decision_id) : null;
    const previousSuccess = body.previous_success !== undefined ? Boolean(body.previous_success) : null;
    const previousOutcome = body.previous_outcome ? String(body.previous_outcome) : null;
    if (previousOutcome && previousOutcome.length > 2000) return err('previous_outcome max 2000 characters', 400);
    const previousCausedBy = body.previous_caused_by ? String(body.previous_caused_by) : null;

    const workflow = new WorkflowService(env.DB);
    let previousCommitted = false;
    let insight: string | null = null;
    let updatedSuccessRate: number | null = null;

    // ── STEP 1: Auto-commit previous session (if provided) ──────────────────
    if (previousDecisionId && previousOutcome !== null && previousSuccess !== null) {
      try {
        const commitResult = await workflow.after(
          {
            decision_id: previousDecisionId,
            success: previousSuccess,
            outcome: previousOutcome,
            related_decision_id: previousCausedBy ?? undefined,
          },
          ctx.account_id
        );
        previousCommitted = true;
        updatedSuccessRate = commitResult.new_success_rate ?? null;

        // Surface insight if hive signals suggest a new pattern
        const signals = commitResult.hive_signals || [];
        if (signals.length > 0 && previousSuccess) {
          insight = `Pattern detected: ${signals[0]?.type || signals[0]?.decision_type || 'recurring success'} trending in hive`;
        }
      } catch (_commitErr) {
        // Non-fatal: continue opening new session even if commit fails
        console.error('auto-commit of previous session failed:', _commitErr);
      }
    }

    // T14: Auto-snapshot if 10+ decisions since last snapshot (non-blocking)
    autoSnapshotIfNeeded(env.DB, ctx.account_id, env.ENCRYPTION_KEY).catch(() => {});

    // Look up org settings — PII strip + default visibility (hive contribution control)
    let orgPiiStripTeam = false;
    if (ctx.tier === 'enterprise') {
      const orgSvc = new OrgService(env.DB);
      const org = await orgSvc.getOrgForAccount(ctx.account_id);
      if (org) {
        orgPiiStripTeam = !!org.pii_strip_team;
        // Apply org default_visibility if agent didn't set one explicitly
        if (!body.visibility && org.default_visibility) {
          visibility = org.default_visibility as 'private' | 'shared' | 'hive' | 'team';
        }
      }
    }

    // ── STEP 2: Open new session with full intelligence ──────────────────────
    const result = await workflow.before(
      {
        decision_type: type,
        action,
        description: action,
        visibility,
        session_id: reqSessionId,
        agent_id: reqAgentId,
      },
      ctx.account_id,
      ctx.tier,
      orgPiiStripTeam
    );

    // Update agent last_active_at on think (non-blocking)
    if (reqAgentId) {
      env.DB.prepare("UPDATE agents SET last_active_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND account_id = ?")
        .bind(reqAgentId, ctx.account_id).run().catch(() => {});
    }

    // ── STEP 3: Pattern Engine — clustering, failure detection, workflow gaps ──
    const patternEngine = new PatternEngine(env.DB);
    const engineResult = await patternEngine.analyze(ctx.account_id, action, type, result.decision_id).catch(() => ({ insights: [], clusterId: null }));

    // T20: Stream URL for live updates
    const streamUrl = `/v1/stream?decision_type=${encodeURIComponent(type)}&format=sse`;

    // Use updated success rate (post-commit) if available, else use pre-existing analytics
    const successRate = updatedSuccessRate !== null ? updatedSuccessRate : (result.current_success_rate ?? 0.75);

    // Map patterns with correct field names
    const mappedPatterns = (result.patterns || []).map((p: Record<string, unknown>) => ({
      pattern_id: p.pattern_signature || p.id || null,
      decision_type: p.decision_type || type,
      frequency: typeof p.frequency === 'number' ? p.frequency : 1,
      confidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
      first_seen: p.first_seen || null,
      last_seen: p.last_seen || null,
    }));

    // Build actionable insights array from pattern engine + frequency patterns
    const actionableInsights = [...(engineResult.insights || [])];

    // Add frequency insights from discovered patterns
    if (mappedPatterns.length > 0) {
      const topPattern = mappedPatterns.sort((a: { frequency: number }, b: { frequency: number }) => b.frequency - a.frequency)[0];
      if (topPattern.confidence > 0.3) {
        actionableInsights.push({
          type: 'frequency' as const,
          summary: `"${type}" recurring ${topPattern.frequency}x — confidence ${(topPattern.confidence * 100).toFixed(0)}%`,
          action: `Review if "${type}" decisions need optimization`,
          severity: (topPattern.confidence > 0.8 ? 'info' : 'warning') as 'info' | 'warning',
          count: topPattern.frequency,
        });
      }
    }

    // Generate primary insight string (backwards compatible)
    if (!insight) {
      // Prioritize: workflow_gap > failure_pattern > frequency
      const criticalInsight = actionableInsights.find(i => i.severity === 'critical');
      const warningInsight = actionableInsights.find(i => i.severity === 'warning');
      const anyInsight = actionableInsights[0];
      const primaryInsight = criticalInsight || warningInsight || anyInsight;
      if (primaryInsight) {
        insight = primaryInsight.summary;
      }
    }

    // ── Gap 1: First think() onboarding signal (non-blocking) ──
    if (env.RESEND_API_KEY) {
      env.DB
        .prepare('SELECT first_think_at, email FROM accounts WHERE id = ? LIMIT 1')
        .bind(ctx.account_id)
        .first<{ first_think_at: string | null; email: string }>()
        .then(async (acct) => {
          if (acct && !acct.first_think_at) {
            const ts = new Date().toISOString();
            // M1 fix: Use meta.changes to prevent duplicate emails on race condition
            const updateResult = await env.DB
              .prepare('UPDATE accounts SET first_think_at = ? WHERE id = ? AND first_think_at IS NULL')
              .bind(ts, ctx.account_id)
              .run();
            // Only send email if we actually won the race (row was changed)
            if ((updateResult.meta?.changes ?? 0) > 0 && acct.email) {
              const html = emailCard('Your agent just logged its first decision 🧠', `
                <p style="margin:0 0 20px;font-size:14px;color:#999;line-height:1.6;">You're in. Marrow is now learning your patterns. Come back in 7 days — you'll see your success rate starting to form.</p>
                <div style="background:#1a1a1a;padding:16px;border-radius:8px;margin:0 0 24px;">
                  <p style="margin:0;font-size:32px;font-weight:700;color:#ffffff;">1</p>
                  <p style="margin:4px 0 0;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:1px;">decision logged</p>
                </div>
                <a href="https://getmarrow.ai" style="display:inline-block;padding:10px 20px;background:#ffffff;color:#0a0a0a;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;">View your dashboard →</a>
              `);
              sendEmail(env, acct.email, 'Your agent just logged its first decision 🧠', html).catch(() => {});
            }
          }
        })
        .catch(() => {});
    }

    // ── Gap 3: Upgrade hint for free tier users near limits (non-blocking check) ──
    let upgradeHint: Record<string, unknown> | null = null;
    if (ctx.tier === 'free') {
      try {
        const decisionCount = await env.DB
          .prepare('SELECT COUNT(*) as c FROM decisions WHERE account_id = ?')
          .bind(ctx.account_id)
          .first<{ c: number }>();
        const count = decisionCount?.c || 0;
        const freeLimit = 500;
        const retentionDays = 30;
        if (count > freeLimit * 0.8) {
          upgradeHint = {
            message: `You've logged ${count} decisions. Free tier keeps ${retentionDays} days. Upgrade to Pro for 1 year retention + private decisions.`,
            tier: 'pro',
            url: 'https://getmarrow.ai/pricing',
          };
        }
      } catch (_e) {
        // Non-fatal
      }
    }

    const response: Record<string, unknown> = {
      decision_id: result.decision_id,
      sanitized,
      warnings: result.warnings || [],
      intelligence: {
        similar: (result.similar_decisions || []).map((d: Record<string, unknown>) => ({
          outcome: d.outcome || d.description || '',
          confidence: typeof d.confidence === 'number' ? d.confidence : 0.5,
        })),
        similar_count: (result.similar_decisions || []).length,
        patterns: mappedPatterns,
        patterns_count: mappedPatterns.length,
        templates: (result.bootstrap_templates || []).map((t: Record<string, unknown>) => ({
          steps: Array.isArray(t.template_decisions) ? t.template_decisions : [],
          success_rate: typeof t.success_rate === 'number' ? t.success_rate : 0.5,
        })),
        shared: (result.shared_context || []).map((s: Record<string, unknown>) => ({
          outcome: s.outcome || s.description || '',
        })),
        causal_chain: result.causal_context || null,
        success_rate: successRate,
        priority_score: result.priority_score ?? 0.5,
        velocity: 0,
        insight,
        insights: actionableInsights,
        cluster_id: engineResult.clusterId,
      },
      stream_url: streamUrl,
    };

    // ── Feature 7: Smart onboarding hint ──
    try {
      const decisionCount = await env.DB
        .prepare('SELECT COUNT(*) as c FROM decisions WHERE account_id = ?')
        .bind(ctx.account_id)
        .first<{ c: number }>();
      const count = decisionCount?.c || 0;
      let onboardingHint: string | null = null;
      if (count <= 3) {
        onboardingHint = 'Welcome to Marrow! Log decisions with think/commit to build your intelligence base.';
      } else if (count <= 10) {
        onboardingHint = `You have logged ${count} decisions. After 10, personalized pattern matching begins.`;
      } else if (count <= 50) {
        onboardingHint = 'Pattern matching active. After 50 decisions, workflow detection begins.';
      }
      if (onboardingHint) (response as Record<string, unknown>).onboarding_hint = onboardingHint;
    } catch (_e) { /* non-fatal */ }

    // ── Feature 9: Cross-agent context (same account, other sessions) ──
    try {
      const sessionId = reqSessionId || ctx.account_id;
      const teamRows = await env.DB.prepare(`
        SELECT context, outcome, outcome_success, created_at, decision_type, session_id
        FROM decisions
        WHERE account_id = ? AND session_id IS NOT NULL AND session_id != ?
          AND decision_type NOT LIKE 'post_%' -- Excludes auto-logger entries; extend to 'get_%','put_%','delete_%' if those start writing session_id
          AND created_at > datetime('now', '-24 hours')
        ORDER BY created_at DESC LIMIT 5
      `).bind(ctx.account_id, sessionId).all<{
        context: string; outcome: string; outcome_success: number | null;
        created_at: string; decision_type: string; session_id: string;
      }>();
      if (teamRows.results && teamRows.results.length > 0) {
        const pii = new PiiService();
        const teamContext = (teamRows.results || []).map(r => {
          // Extract action from context JSON (action is stored in context, not as a column)
          let actionText = r.decision_type;
          try {
            const ctx = JSON.parse(r.context || '{}');
            if (typeof ctx.action === 'string') actionText = ctx.action;
            else if (typeof ctx.description === 'string') actionText = ctx.description;
          } catch { /* use decision_type as fallback */ }
          const strippedAction = pii.stripString(actionText);
          const strippedOutcome = pii.stripString(r.outcome || '');
          const hoursAgo = Math.round((Date.now() - new Date(r.created_at).getTime()) / 3600000);
          return {
            agent: r.decision_type,
            action: strippedAction.slice(0, 100),
            outcome: strippedOutcome.slice(0, 100),
            when: hoursAgo <= 1 ? '1 hour ago' : `${hoursAgo} hours ago`,
          };
        });
        (response.intelligence as Record<string, unknown>).team_context = teamContext;
      }
    } catch (_e) { /* non-fatal */ }

    // ── Feature 4: Collective insight from cross-account patterns ──
    try {
      const collective = new CollectiveService(env.DB);
      const collectiveInsight = await collective.getCollectiveInsight(type);
      if (collectiveInsight) {
        (response.intelligence as Record<string, unknown>).collective = collectiveInsight;
      }
    } catch (_e) { /* non-fatal */ }

    // ── Feature 6: Record potential save if HIGH severity insight ──
    if (actionableInsights.some(i => i.severity === 'critical')) {
      const impact = new ImpactService(env.DB);
      const topCritical = actionableInsights.find(i => i.severity === 'critical');
      if (topCritical) {
        await impact.recordPotentialSave(
          ctx.account_id,
          result.decision_id,
          'critical_pattern',
          topCritical.summary
        ).catch(() => {});
      }
    }

    if (upgradeHint) {
      response.upgrade_hint = upgradeHint;

      // Fire upgrade nudge email once (non-blocking)
      if (ctx.tier === 'free' && env.RESEND_API_KEY) {
        const upgradeDecisionCount = (upgradeHint as Record<string, unknown>).message
          ? parseInt(((upgradeHint as Record<string, unknown>).message as string).match(/(\d+) decisions/)?.[1] || '80')
          : 80;
        env.DB.prepare('SELECT email, upgrade_nudge_sent_at FROM accounts WHERE id = ? LIMIT 1')
          .bind(ctx.account_id)
          .first<{ email: string; upgrade_nudge_sent_at: string | null }>()
          .then(async (acct) => {
            if (acct?.email && !acct.upgrade_nudge_sent_at) {
              await env.DB.prepare('UPDATE accounts SET upgrade_nudge_sent_at = ? WHERE id = ?')
                .bind(new Date().toISOString(), ctx.account_id).run();
              const upgradeHtml = emailCard(`${upgradeDecisionCount} decisions in.`, `
                <p style="margin:0 0 20px;font-size:14px;color:#999999;line-height:1.6;"><span style="color:#ffffff;font-weight:600;">${upgradeDecisionCount} decisions in.</span> Your agent is starting to learn how you work.</p>
                <p style="margin:0 0 20px;font-size:14px;color:#999999;line-height:1.6;">On the free tier, Marrow keeps 30 days of decision history. Anything older gets pruned.</p>
                <p style="margin:0 0 8px;font-size:14px;color:#ffffff;font-weight:600;">On Pro:</p>
                <p style="margin:0 0 4px;font-size:14px;color:#999999;line-height:1.6;">1 year retention. Private decisions (not contributed to the hive). Priority context — your oldest patterns weighted higher, not dropped.</p>
                <p style="margin:0 0 20px;font-size:14px;color:#999999;line-height:1.6;">The model you've built over ${upgradeDecisionCount} decisions? It only gets more valuable the longer you keep it.</p>
                <a href="https://getmarrow.ai/pricing" style="display:inline-block;padding:10px 24px;background:#ffffff;color:#0a0a0a;text-decoration:none;border-radius:0px;font-size:13px;font-weight:600;">Upgrade to Pro →</a>
              `);
              sendEmail(env, acct.email, `You've logged ${upgradeDecisionCount} decisions. Here's what you're not seeing.`, upgradeHtml).catch(() => {});
            }
          }).catch(() => {});
      }
    }

    if (previousCommitted) {
      response.previous_committed = true;
    }

    response.api_version = MARROW_API_VERSION;

    const clientSdkVersion = request.headers.get('X-SDK-Version');
    const sdkUpdateAvailable = clientSdkVersion && clientSdkVersion !== MARROW_SDK_LATEST
      ? { latest: MARROW_SDK_LATEST, current: clientSdkVersion, message: `Update available: npm install @getmarrow/sdk@${MARROW_SDK_LATEST}` }
      : undefined;
    if (sdkUpdateAvailable) response.sdk_update = sdkUpdateAvailable;

    return json(response);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('POST /v1/agent/think error:', msg);
    return err('Failed to gather intelligence', 500);
  }
});

// ============= Gap 2: Agent-Queryable Failure Patterns =============
router.get('/v1/agent/patterns', async (request: IRequest, env: Env) => {
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
    const typeFilter = url.searchParams.get('type') || null;
    // L1 fix: Clamp limit to prevent NaN propagation from invalid input
    const rawLimit = parseInt(url.searchParams.get('limit') || '20');
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 20 : Math.min(rawLimit, 100);
    const db = env.DB;
    const accountId = ctx.account_id;

    // Failure patterns: group by decision_type, compute failure rate
    let failureQuery = `
      SELECT decision_type,
        COUNT(*) as count,
        SUM(CASE WHEN outcome_success = 0 THEN 1 ELSE 0 END) as failures,
        MAX(created_at) as last_seen
      FROM decisions
      WHERE account_id = ? AND outcome_recorded_at IS NOT NULL
    `;
    const failureBinds: (string | number)[] = [accountId];
    if (typeFilter) {
      failureQuery += ' AND decision_type = ?';
      failureBinds.push(typeFilter);
    }
    failureQuery += ' GROUP BY decision_type ORDER BY failures DESC LIMIT ?';
    failureBinds.push(limit);

    const failureRows = await db.prepare(failureQuery).bind(...failureBinds)
      .all<{ decision_type: string; count: number; failures: number; last_seen: string }>();

    const failurePatterns = (failureRows.results || [])
      .filter(r => r.failures > 0)
      .map(r => ({
        decision_type: r.decision_type,
        failure_rate: Math.round((r.failures / r.count) * 100) / 100,
        count: r.count,
        last_seen: r.last_seen,
      }));

    // Recurring decisions: group by decision_type, compute frequency + avg confidence
    let recurringQuery = `
      SELECT decision_type,
        COUNT(*) as frequency,
        AVG(confidence) as avg_confidence
      FROM decisions
      WHERE account_id = ?
    `;
    const recurringBinds: (string | number)[] = [accountId];
    if (typeFilter) {
      recurringQuery += ' AND decision_type = ?';
      recurringBinds.push(typeFilter);
    }
    recurringQuery += ' GROUP BY decision_type HAVING COUNT(*) > 1 ORDER BY frequency DESC LIMIT ?';
    recurringBinds.push(limit);

    const recurringRows = await db.prepare(recurringQuery).bind(...recurringBinds)
      .all<{ decision_type: string; frequency: number; avg_confidence: number }>();

    const recurringDecisions = (recurringRows.results || []).map(r => ({
      decision_type: r.decision_type,
      frequency: r.frequency,
      avg_confidence: Math.round((r.avg_confidence || 0) * 100) / 100,
      trend: 'stable' as string, // default
    }));

    // Behavioral drift: compare 7-day vs 30-day success rate from analytics_snapshots
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

    const recent7d = await db.prepare(
      'SELECT AVG(value) as avg_val FROM analytics_snapshots WHERE account_id = ? AND metric_name = ? AND recorded_at > ?'
    ).bind(accountId, 'success_rate', sevenDaysAgo).first<{ avg_val: number | null }>();

    const recent30d = await db.prepare(
      'SELECT AVG(value) as avg_val FROM analytics_snapshots WHERE account_id = ? AND metric_name = ? AND recorded_at > ?'
    ).bind(accountId, 'success_rate', thirtyDaysAgo).first<{ avg_val: number | null }>();

    const sr7d = recent7d?.avg_val ?? 0;
    const sr30d = recent30d?.avg_val ?? 0;
    const driftPct = sr30d > 0 ? ((sr7d - sr30d) / sr30d) * 100 : 0;

    const behavioralDrift = {
      success_rate_7d: Math.round(sr7d * 100) / 100,
      success_rate_30d: Math.round(sr30d * 100) / 100,
      drift: (driftPct >= 0 ? '+' : '') + driftPct.toFixed(1) + '%',
      direction: driftPct > 0 ? 'improving' : driftPct < 0 ? 'declining' : 'stable',
    };

    // Top failure types
    const topFailureTypes = failurePatterns
      .sort((a, b) => b.failure_rate - a.failure_rate)
      .slice(0, 5)
      .map(f => f.decision_type);

    return json({
      failure_patterns: failurePatterns,
      recurring_decisions: recurringDecisions,
      behavioral_drift: behavioralDrift,
      top_failure_types: topFailureTypes,
      generated_at: new Date().toISOString(),
    });
  } catch (e: unknown) {
    console.error('GET /v1/agent/patterns error:', e);
    return err('Failed to fetch patterns', 500);
  }
});

// ============= Feature 5: Auto-Workflow Suggestions (orient integration) =============
router.get('/v1/agent/suggestions', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    autoLogDecision({ db: env.DB, accountId: ctx.account_id, method: request.method, endpoint: '/v1/agent/suggestions', statusCode: 200, tier: ctx.tier, sessionId: request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null }).catch(() => {});

    const rlAllowed = await checkRateLimit(env.DB, `agent_suggestions:${ctx.account_id}`, 30, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const detection = new WorkflowDetectionService(env.DB);
    const suggestions = await detection.getSuggestions(ctx.account_id);

    return json({ suggested_workflows: suggestions });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('GET /v1/agent/suggestions error:', msg);
    return err('Internal server error', 500);
  }
});

// Backward-compat alias: /v1/agent/commit routes to think logic with action='commit_only'
router.post('/v1/agent/commit', async (request: IRequest, env: Env) => {
  try {
    // T1: Auth
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const commitSessionId = request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null;

    // Resolve agent_id: PATH 2 header > PATH 1 auth-derived
    let commitAgentId: string | null = ctx.agent_id || null;
    const commitHeaderAgentId = request.headers.get('X-Marrow-Agent-Id');
    if (commitHeaderAgentId && /^[a-f0-9-]{36}$/.test(commitHeaderAgentId)) {
      const agentCheck = await env.DB
        .prepare("SELECT id FROM agents WHERE id = ? AND account_id = ? AND status != 'archived' LIMIT 1")
        .bind(commitHeaderAgentId, ctx.account_id)
        .first<{ id: string }>();
      if (agentCheck) commitAgentId = agentCheck.id;
    }

    // Auto-log this API call as a decision (non-blocking, fire-and-forget)
    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: request.url.split(new URL(request.url).origin).pop() || request.url,
      statusCode: 200,
      tier: ctx.tier,
      sessionId: commitSessionId,
    }).catch(() => {});

    const body = await request.json() as Record<string, unknown>;
    if (!body.decision_id || typeof body.decision_id !== 'string') {
      return err('decision_id is required', 400);
    }
    if (body.success === undefined || body.success === null) {
      return err('success is required', 400);
    }
    if (!body.outcome || typeof body.outcome !== 'string') {
      return err('outcome is required', 400);
    }

    // Route to the same workflow.after logic (backward compat — commit_only mode)
    const workflow = new WorkflowService(env.DB);
    const result = await workflow.after(
      {
        decision_id: String(body.decision_id),
        success: Boolean(body.success),
        outcome: String(body.outcome),
        related_decision_id: body.caused_by ? String(body.caused_by) : undefined,
      },
      ctx.account_id
    );

    // Best-effort backfill session_id if currently NULL on the committed decision
    if (commitSessionId) {
      env.DB.prepare('UPDATE decisions SET session_id = ? WHERE id = ? AND account_id = ? AND session_id IS NULL')
        .bind(commitSessionId, String(body.decision_id), ctx.account_id).run().catch(() => {});
    }

    // PATH 3: Backfill agent_id + update agent stats on commit
    if (commitAgentId) {
      env.DB.prepare('UPDATE decisions SET agent_id = ? WHERE id = ? AND account_id = ? AND agent_id IS NULL')
        .bind(commitAgentId, String(body.decision_id), ctx.account_id).run().catch(() => {});
      // Update agent stats: last_active_at + total_decisions
      env.DB.prepare("UPDATE agents SET last_active_at = datetime('now'), total_decisions = total_decisions + 1, updated_at = datetime('now') WHERE id = ? AND account_id = ?")
        .bind(commitAgentId, ctx.account_id).run().catch(() => {});
    }

    // ── Feature 6: Confirm save if this decision was flagged as a potential save ──
    if (Boolean(body.success)) {
      const impact = new ImpactService(env.DB);
      await impact.confirmSave(ctx.account_id, String(body.decision_id), true).catch(() => {});
    }

    return json({
      committed: true,
      success_rate: result.new_success_rate ?? 0.75,
      insight: null,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('POST /v1/agent/commit error:', msg);
    return err('Failed to commit decision', 500);
  }
});

// ============= UNIFIED WORKFLOW: ALL 20 TIERS AS ONE =============

router.post('/v1/workflow/before', async (request: IRequest, env: Env) => {
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

    const body = (await request.json()) as Record<string, unknown>;
    if (!body.decision_type || !body.action || !body.description) {
      return err('Missing required fields: decision_type, action, description', 400);
    }

    const workflow = new WorkflowService(env.DB);
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

    return json(result, 200);
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
    // Auto-log this API call as a decision (non-blocking, fire-and-forget)
    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: request.url.split(new URL(request.url).origin).pop() || request.url,
      statusCode: 200,

      tier: ctx.tier,
    }).catch(() => {});

    const body = (await request.json()) as Record<string, unknown>;
    if (!body.decision_id || body.success === undefined || !body.outcome) {
      return err('Missing required fields: decision_id, success, outcome', 400);
    }

    const workflow = new WorkflowService(env.DB);
    const result = await workflow.after(
      {
        decision_id: String(body.decision_id || ''),
        success: Boolean(body.success),
        outcome: String(body.outcome || ''),
        related_decision_id: body.related_decision_id ? String(body.related_decision_id) : undefined,
      },
      ctx.account_id
    );

    return json(result, 200);
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

    const workflow = new WorkflowService(env.DB);
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

// ============= Feature 2: Session End =============
router.post('/v1/agent/session/end', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    autoLogDecision({ db: env.DB, accountId: ctx.account_id, method: request.method, endpoint: '/v1/agent/session/end', statusCode: 200, tier: ctx.tier, sessionId: request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null }).catch(() => {});

    const rlAllowed = await checkRateLimit(env.DB, `session_end:${ctx.account_id}`, 10, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const body = await request.json() as Record<string, unknown>;
    // Validate session_id if provided (must be reasonable length, no injection)
    const rawSessionId = body.session_id ? String(body.session_id).slice(0, 200) : null;
    const sessionId = rawSessionId ||
      request.headers.get('X-Marrow-Session-Id')?.slice(0, 200) || request.headers.get('X-Session-Id')?.slice(0, 200) ||
      ctx.account_id;
    const autoCommitOpen = body.auto_commit_open === true;

    const sessionService = new SessionService(env.DB);
    const result = await sessionService.endSession(sessionId, ctx.account_id, autoCommitOpen);

    if (autoCommitOpen && result.committed > 0) {
      console.warn('[session/end] auto-committed open decision on explicit caller request', { accountId: ctx.account_id, sessionId, openDecisionId: result.openDecisionId });
    }

    return json({ session_id: sessionId, committed: result.committed, open_decision_id: result.openDecisionId });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('POST /v1/agent/session/end error:', msg);
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

    // P4 fix: Query decisions directly instead of relying on daily_stats (which may be empty)
    const [currentPeriod, previousPeriod, dashboardData, savesCount] = await Promise.all([
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

    const summary = `${totalDecisions} decisions this period, ${Math.round(currentRate * 100)}% success rate (${direction}). ${savesCount.thisWeek} failures prevented by pattern matching. Agents completed tasks in ${velocity.time_to_success_seconds.current}s median (${velocity.time_to_success_seconds.direction} vs prior), with ${velocity.attempts_per_success.current} attempts per success on average.`;

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
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('GET /v1/digest error:', msg);
    return err('Internal server error', 500);
  }
});



// GET /v1/agent/status — quick health check for SDK quickStatus()
router.get('/v1/agent/status', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const rlAllowed = await checkRateLimit(env.DB, `agent_status:${ctx.account_id}`, 60, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    autoLogDecision({
      db: env.DB, accountId: ctx.account_id, method: request.method,
      endpoint: '/v1/agent/status', statusCode: 200, tier: ctx.tier,
      sessionId: request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null,
    }).catch(() => {});

    const row = await env.DB.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as succ,
             SUM(CASE WHEN outcome_success = 0 THEN 1 ELSE 0 END) as fail
      FROM decisions
      WHERE account_id = ? AND outcome_success IS NOT NULL
    `).bind(ctx.account_id).first<{ total: number; succ: number; fail: number }>();

    const total = row?.total || 0;
    const succ = row?.succ || 0;
    const fail = row?.fail || 0;
    const successRate = (succ + fail) > 0 ? succ / (succ + fail) : null;
    const health = fail > succ * 0.5 ? 'degraded' : 'healthy';
    const message = total === 0
      ? 'Welcome to Marrow! Log your first decision with think() to get started.'
      : total < 10
      ? `Getting started — ${total} decision${total === 1 ? '' : 's'} logged. Keep going for pattern detection.`
      : `${total} decisions tracked. Success rate: ${Math.round((successRate || 0) * 100)}%.`;

    return json({
      ok: true,
      health,
      message,
      has_memory: total > 0,
      low_history: total < 10,
      decision_count: total,
      success_rate: successRate,
    });
  } catch (e: unknown) {
    console.error('GET /v1/agent/status error:', e);
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

// ---------- Fleet Dashboard ----------

// GET /v1/fleet — fleet status
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

router.all('*', () => err('Not found', 404));

// ============= Export =============

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const response = await router.handle(request, env, ctx);
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
      const msg = e instanceof Error ? e.message : 'Unknown error';
      const stack = e instanceof Error ? e.stack : '';
      console.error('Unhandled fetch error:', msg, stack);
      console.error('Unhandled error:', msg, stack);
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
