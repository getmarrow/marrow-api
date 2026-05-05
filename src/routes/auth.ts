import { Router, type IRequest } from 'itty-router';
import type { Env, ManagedApiKey, RequestContext } from '../types';
import { AuthServiceError } from '../services/auth.service';
import { checkRateLimit } from '../utils/rate-limit';
import { getServices } from '../lib/services';
import { ok, fail } from '../lib/response';
import { withAuth } from '../middleware/auth';
import { withErrorBoundary } from '../middleware/error-boundary';
import { isTestKeyContext } from '../middleware/policy';
import { safelyAsync } from '../utils/safely';

function rawJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getUrl(request: IRequest): URL {
  return new URL(request.url);
}

function filterKeysForContext(ctx: RequestContext, keys: ManagedApiKey[]): ManagedApiKey[] {
  return isTestKeyContext(ctx) ? keys.filter((key) => key.key_type === 'test') : keys;
}

function ensureTestKeyManagedKeyAccess(ctx: RequestContext, key: ManagedApiKey | null): Response | null {
  if (!isTestKeyContext(ctx)) return null;
  if (!key) return fail('NOT_FOUND', 'Not found', 404);
  if (key.key_type !== 'test') return fail('FORBIDDEN', 'Test keys can only manage test keys.', 403);
  return null;
}

function authError(error: unknown): Response {
  if (error instanceof AuthServiceError) return fail(error.status === 404 ? 'NOT_FOUND' : 'AUTH_ERROR', error.message, error.status);
  throw error;
}

export const router = Router();

router.post('/v1/keys/request', withErrorBoundary(async (request: IRequest, env: Env) => {
  const body = await request.json() as { email?: string };
  const email = (body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return fail('BAD_REQUEST', 'Invalid email', 400);

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const ipAllowed = await checkRateLimit(env.DB, `otp_request_ip:${ip}`, 10, 60 * 60 * 1000);
  if (!ipAllowed) return fail('RATE_LIMITED', 'Too many requests. Try again later.', 429);

  const allowed = await checkRateLimit(env.DB, `otp_request_email:${email}`, 5, 60 * 60 * 1000);
  if (!allowed) return fail('RATE_LIMITED', 'Too many requests. Try again later.', 429);

  const services = getServices(env);
  const otp = services.otp.generateOtp();
  await services.otp.storeOtp(email, otp);

  const isDev = env.ENVIRONMENT === 'development';
  if (!env.RESEND_API_KEY) {
    if (isDev) console.log(`[OTP DEBUG] email=${email} otp=${otp}`);
    return rawJson({ sent: true, ...(isDev ? { debug_otp: otp } : {}) });
  }

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
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Marrow <noreply@mail.getmarrow.ai>',
      to: email,
      subject: 'Your Marrow API key verification code',
      text: emailText,
      html: emailHtml,
    }),
  });

  if (!resendRes.ok) {
    const resendErr = await resendRes.text();
    console.error(`[Resend error] ${resendErr}`);
    return fail('INTERNAL_ERROR', 'Failed to send email', 500);
  }

  return rawJson({ sent: true });
}));

router.post('/v1/keys/verify', withErrorBoundary(async (request: IRequest, env: Env) => {
  const body = await request.json() as { email?: string; otp?: string };
  const email = (body?.email || '').trim().toLowerCase();
  const otp = (body?.otp || '').trim();
  if (!email || !otp) return fail('BAD_REQUEST', 'email and otp are required', 400);

  const verifyAllowed = await checkRateLimit(env.DB, `otp_verify:${email}`, 5, 10 * 60 * 1000);
  if (!verifyAllowed) return fail('RATE_LIMITED', 'Too many verification attempts. Try again later.', 429);

  const services = getServices(env);
  const valid = await services.otp.verifyOtp(email, otp);
  if (!valid) return fail('UNAUTHORIZED', 'Invalid or expired OTP', 401);

  const account = await env.DB.prepare('SELECT id FROM accounts WHERE email = ? LIMIT 1').bind(email).first<{ id: string }>();

  let accountId: string;
  if (!account) {
    const created = await services.auth.createAccount(email, email, 'free');
    accountId = created.id;
  } else {
    accountId = account.id;
  }

  const keyRow = await env.DB
    .prepare(`SELECT ak.id, ak.key_hash FROM api_keys ak WHERE ak.account_id = ? AND ak.status = 'active' LIMIT 1`)
    .bind(accountId)
    .first<{ id: string; key_hash: string }>();

  if (keyRow) {
    await env.DB
      .prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE account_id = ? AND status = 'active'")
      .bind(new Date().toISOString(), accountId)
      .run();
  }

  const created = await services.auth.createApiKey(accountId, { createdBy: 'signup', name: 'Primary signup key' });
  void safelyAsync(services.email.sendTemplate(accountId, email, 'welcome', { email }), 'welcome-email');

  return rawJson({ apiKey: created.key });
}));

router.post('/v1/auth/accounts', withErrorBoundary(async (request: IRequest, env: Env) => {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const allowed = await checkRateLimit(env.DB, `acct_create:${ip}`, 3, 60 * 60 * 1000);
  if (!allowed) return fail('RATE_LIMITED', 'Too many account creation requests. Try again later.', 429);

  const body = await request.json() as Record<string, unknown>;
  const services = getServices(env);
  const account = await services.auth.createAccount(String(body.name || ''), String(body.email || ''), 'free');
  const { key, keyId } = await services.auth.createApiKey(account.id, { createdBy: 'signup', name: 'Primary signup key' });
  void safelyAsync(services.email.sendTemplate(account.id, account.email, 'welcome', { email: account.email }), 'welcome-email');
  return ok({ account, api_key: key, key_id: keyId }, 201);
}));

router.get('/v1/auth/account', withErrorBoundary(withAuth(async (request: IRequest, env: Env) => {
  const ctx = request.ctx as RequestContext;
  const account = await getServices(env).auth.getAccount(ctx.account_id);
  if (!account) return fail('NOT_FOUND', 'Not found', 404);
  if (isTestKeyContext(ctx)) return ok({ tier: account.tier });
  return ok(account);
})));

router.get('/v1/auth/keys', withErrorBoundary(withAuth(async (request: IRequest, env: Env) => {
  const ctx = request.ctx as RequestContext;
  try {
    const keys = filterKeysForContext(ctx, await getServices(env).auth.listKeys(ctx.account_id));
    return ok({ keys });
  } catch (error) {
    return authError(error);
  }
})));

router.post('/v1/auth/keys', withErrorBoundary(withAuth(async (request: IRequest, env: Env) => {
  const ctx = request.ctx as RequestContext;
  const body = await request.json() as {
    name?: string;
    key_type?: 'live' | 'test';
    scopes?: string[];
    expires_at?: string | null;
    agent_ids?: string[];
  };

  if (isTestKeyContext(ctx) && body.key_type && body.key_type !== 'test') {
    return fail('FORBIDDEN', 'Test keys can only manage test keys.', 403);
  }

  try {
    const created = await getServices(env).auth.createApiKey(
      ctx.account_id,
      {
        name: body.name,
        keyType: isTestKeyContext(ctx) ? 'test' : body.key_type,
        scopes: body.scopes,
        expiresAt: body.expires_at,
        agentIds: body.agent_ids,
        createdBy: 'dashboard',
      },
      {
        ip: request.headers.get('cf-connecting-ip'),
        userAgent: request.headers.get('user-agent'),
      },
    );
    return ok({ key: created.key, key_id: created.keyId, masked_key: created.maskedKey }, 201);
  } catch (error) {
    return authError(error);
  }
})));

router.get('/v1/auth/keys/audit', withErrorBoundary(withAuth(async (request: IRequest, env: Env) => {
  const ctx = request.ctx as RequestContext;
  if (isTestKeyContext(ctx)) return fail('FORBIDDEN', 'Test keys cannot access production data.', 403);
  const url = getUrl(request);
  const page = Number(url.searchParams.get('page') || '1');
  const pageSize = Number(url.searchParams.get('page_size') || url.searchParams.get('limit') || '20');
  try {
    const audit = await getServices(env).auth.listKeyAudit(ctx.account_id, page, pageSize);
    return ok(audit);
  } catch (error) {
    return authError(error);
  }
})));

router.get('/v1/auth/keys/:id', withErrorBoundary(withAuth(async (request: IRequest, env: Env) => {
  const ctx = request.ctx as RequestContext;
  try {
    const key = await getServices(env).auth.getKey(String(request.params?.id || ''), ctx.account_id);
    const accessError = ensureTestKeyManagedKeyAccess(ctx, key);
    if (accessError) return accessError;
    if (!key) return fail('NOT_FOUND', 'Not found', 404);
    return ok({ key });
  } catch (error) {
    return authError(error);
  }
})));

router.post('/v1/auth/keys/:id/revoke', withErrorBoundary(withAuth(async (request: IRequest, env: Env) => {
  const ctx = request.ctx as RequestContext;
  const keyId = String(request.params?.id || '');
  try {
    const key = await getServices(env).auth.getKey(keyId, ctx.account_id);
    const accessError = ensureTestKeyManagedKeyAccess(ctx, key);
    if (accessError) return accessError;
    await getServices(env).auth.revokeApiKey(keyId, ctx.account_id, {
      ip: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
    }, 'user');
    return ok({ revoked: true });
  } catch (error) {
    return authError(error);
  }
})));

router.post('/v1/auth/keys/:id/rotate', withErrorBoundary(withAuth(async (request: IRequest, env: Env) => {
  const ctx = request.ctx as RequestContext;
  const keyId = String(request.params?.id || '');
  try {
    const key = await getServices(env).auth.getKey(keyId, ctx.account_id);
    const accessError = ensureTestKeyManagedKeyAccess(ctx, key);
    if (accessError) return accessError;
    const rotated = await getServices(env).auth.rotateKey(keyId, ctx.account_id, {
      ip: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
    }, 'user');
    return ok({ key: rotated.key, key_id: rotated.keyId, masked_key: rotated.maskedKey });
  } catch (error) {
    return authError(error);
  }
})));

router.post('/v1/auth/keys/revoke', withErrorBoundary(withAuth(async (request: IRequest, env: Env) => {
  const ctx = request.ctx as RequestContext;
  const body = await request.json() as Record<string, unknown>;
  const keyId = String(body.key_id || '');
  try {
    const key = await getServices(env).auth.getKey(keyId, ctx.account_id);
    const accessError = ensureTestKeyManagedKeyAccess(ctx, key);
    if (accessError) return accessError;
    await getServices(env).auth.revokeApiKey(keyId, ctx.account_id, {
      ip: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
    }, 'user');
    return ok({ revoked: true });
  } catch (error) {
    return authError(error);
  }
})));

export default router;
