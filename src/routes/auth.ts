import type { IRequest } from 'itty-router';
import { AuthServiceError } from '../services/auth.service';
import {
  Router,
  type Env,
  checkRateLimit,
  createServices,
  ensureTestKeyManagedKeyAccess,
  err,
  filterKeysForContext,
  getUrl,
  isTestKeyContext,
  json,
  requireAuth,
  safelyAsync,
} from './shared';

export const authRouter = Router();

authRouter.post('/v1/keys/request', async (request: IRequest, env: Env) => {
  try {
    const body = await request.json() as { email?: string };
    const email = (body?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return err('Invalid email', 400);

    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const ipAllowed = await checkRateLimit(env.DB, `otp_request_ip:${ip}`, 10, 60 * 60 * 1000);
    if (!ipAllowed) return err('Too many requests. Try again later.', 429);

    const allowed = await checkRateLimit(env.DB, `otp_request_email:${email}`, 5, 60 * 60 * 1000);
    if (!allowed) return err('Too many requests. Try again later.', 429);

    const services = createServices(env);
    const otp = services.otp().generateOtp();
    await services.otp().storeOtp(email, otp);

    const isDev = env.ENVIRONMENT === 'development';
    if (!env.RESEND_API_KEY) {
      if (isDev) console.log(`[OTP DEBUG] email=${email} otp=${otp}`);
      return new Response(JSON.stringify({ sent: true, ...(isDev ? { debug_otp: otp } : {}) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
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

authRouter.post('/v1/keys/verify', async (request: IRequest, env: Env) => {
  try {
    const body = await request.json() as { email?: string; otp?: string };
    const email = (body?.email || '').trim().toLowerCase();
    const otp = (body?.otp || '').trim();
    if (!email || !otp) return err('email and otp are required', 400);

    const verifyAllowed = await checkRateLimit(env.DB, `otp_verify:${email}`, 5, 10 * 60 * 1000);
    if (!verifyAllowed) return err('Too many verification attempts. Try again later.', 429);

    const services = createServices(env);
    const valid = await services.otp().verifyOtp(email, otp);
    if (!valid) return err('Invalid or expired OTP', 401);

    let account = await env.DB.prepare('SELECT id FROM accounts WHERE email = ? LIMIT 1').bind(email).first<{ id: string }>();

    let accountId: string;
    if (!account) {
      const created = await services.auth().createAccount(email, email, 'free');
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

    const created = await services.auth().createApiKey(accountId, { createdBy: 'signup', name: 'Primary signup key' });
    safelyAsync(services.email().sendTemplate(accountId, email, 'welcome', { email }), 'welcome-email');

    return new Response(JSON.stringify({ apiKey: created.key }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[/v1/keys/verify]', e);
    return err('Internal error', 500);
  }
});

authRouter.post('/v1/auth/accounts', async (request: IRequest, env: Env) => {
  try {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const allowed = await checkRateLimit(env.DB, `acct_create:${ip}`, 3, 60 * 60 * 1000);
    if (!allowed) return err('Too many account creation requests. Try again later.', 429);

    const body = await request.json() as Record<string, unknown>;
    const services = createServices(env);
    const account = await services.auth().createAccount(String(body.name || ''), String(body.email || ''), 'free');
    const { key, keyId } = await services.auth().createApiKey(account.id, { createdBy: 'signup', name: 'Primary signup key' });
    safelyAsync(services.email().sendTemplate(account.id, account.email, 'welcome', { email: account.email }), 'welcome-email');
    return json({ account, api_key: key, key_id: keyId }, 201);
  } catch {
    return err('Internal error');
  }
});

authRouter.get('/v1/auth/account', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult;
    const account = await createServices(env).auth().getAccount(ctx.account_id);
    if (!account) return err('Not found', 404);
    if (isTestKeyContext(ctx)) return json({ tier: account.tier });
    return json(account);
  } catch {
    return err('Internal error');
  }
});

authRouter.get('/v1/auth/keys', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult;
    const keys = filterKeysForContext(ctx, await createServices(env).auth().listKeys(ctx.account_id));
    return json({ keys });
  } catch (e: unknown) {
    if (e instanceof AuthServiceError) return err(e.message, e.status);
    return err('Internal error');
  }
});

authRouter.post('/v1/auth/keys', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult;
    const body = await request.json() as {
      name?: string;
      key_type?: 'live' | 'test';
      scopes?: string[];
      expires_at?: string | null;
      agent_ids?: string[];
    };
    if (isTestKeyContext(ctx) && body.key_type && body.key_type !== 'test') {
      return err('Test keys can only manage test keys.', 403);
    }
    const created = await createServices(env).auth().createApiKey(
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
    return json({ key: created.key, key_id: created.keyId, masked_key: created.maskedKey }, 201);
  } catch (e: unknown) {
    if (e instanceof AuthServiceError) return err(e.message, e.status);
    return err('Internal error');
  }
});

authRouter.get('/v1/auth/keys/audit', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult;
    if (isTestKeyContext(ctx)) return err('Test keys cannot access production data.', 403);
    const url = getUrl(request);
    const page = Number(url.searchParams.get('page') || '1');
    const pageSize = Number(url.searchParams.get('page_size') || url.searchParams.get('limit') || '20');
    const audit = await createServices(env).auth().listKeyAudit(ctx.account_id, page, pageSize);
    return json(audit);
  } catch (e: unknown) {
    if (e instanceof AuthServiceError) return err(e.message, e.status);
    return err('Internal error');
  }
});

authRouter.get('/v1/auth/keys/:id', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult;
    const key = await createServices(env).auth().getKey(String(request.params?.id || ''), ctx.account_id);
    const accessError = ensureTestKeyManagedKeyAccess(ctx, key);
    if (accessError) return accessError;
    if (!key) return err('Not found', 404);
    return json({ key });
  } catch (e: unknown) {
    if (e instanceof AuthServiceError) return err(e.message, e.status);
    return err('Internal error');
  }
});

authRouter.post('/v1/auth/keys/:id/revoke', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult;
    const keyId = String(request.params?.id || '');
    const services = createServices(env);
    const key = await services.auth().getKey(keyId, ctx.account_id);
    const accessError = ensureTestKeyManagedKeyAccess(ctx, key);
    if (accessError) return accessError;
    await services.auth().revokeApiKey(keyId, ctx.account_id, {
      ip: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
    }, 'user');
    return json({ revoked: true });
  } catch (e: unknown) {
    if (e instanceof AuthServiceError) return err(e.message, e.status);
    return err('Internal error');
  }
});

authRouter.post('/v1/auth/keys/:id/rotate', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult;
    const keyId = String(request.params?.id || '');
    const services = createServices(env);
    const key = await services.auth().getKey(keyId, ctx.account_id);
    const accessError = ensureTestKeyManagedKeyAccess(ctx, key);
    if (accessError) return accessError;
    const rotated = await services.auth().rotateKey(keyId, ctx.account_id, {
      ip: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
    }, 'user');
    return json({ key: rotated.key, key_id: rotated.keyId, masked_key: rotated.maskedKey });
  } catch (e: unknown) {
    if (e instanceof AuthServiceError) return err(e.message, e.status);
    return err('Internal error');
  }
});

authRouter.post('/v1/auth/keys/revoke', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult;
    const body = await request.json() as Record<string, unknown>;
    const services = createServices(env);
    const key = await services.auth().getKey(String(body.key_id), ctx.account_id);
    const accessError = ensureTestKeyManagedKeyAccess(ctx, key);
    if (accessError) return accessError;
    await services.auth().revokeApiKey(String(body.key_id), ctx.account_id, {
      ip: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
    }, 'user');
    return json({ revoked: true });
  } catch (e: unknown) {
    if (e instanceof AuthServiceError) return err(e.message, e.status);
    return err('Internal error');
  }
});

export default authRouter;
