import { Router, type IRequest } from 'itty-router';
import type { Env, RequestContext } from '../types';
import { getServices } from '../lib/services';
import { ok, fail } from '../lib/response';
import { withAuth } from '../middleware/auth';
import { withErrorBoundary } from '../middleware/error-boundary';
import { checkRateLimit } from '../utils/rate-limit';

function getUrl(request: IRequest): URL {
  return new URL(request.url);
}

function authRoute(handler: (request: IRequest, env: Env, ctx: RequestContext) => Promise<Response>): (request: IRequest, env: Env) => Promise<Response> {
  return withErrorBoundary(withAuth(async (request: IRequest, env: Env) => handler(request, env, request.ctx as RequestContext)));
}

// ============= CORS (mirrors index.ts ALLOWED_ORIGINS) =============

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

// ============= Email Helpers =============

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

// ============= Internal Auth =============

async function timingSafeSecretMatch(candidate: string, expected: string, label: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(candidate);
  const bBytes = encoder.encode(expected);
  if (aBytes.length !== bBytes.length) return false;
  const aKey = await crypto.subtle.importKey('raw', aBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bKey = await crypto.subtle.importKey('raw', bBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const msg = encoder.encode(`marrow-${label}`);
  const aHmac = await crypto.subtle.sign('HMAC', aKey, msg);
  const bHmac = await crypto.subtle.sign('HMAC', bKey, msg);
  const aHex = Array.from(new Uint8Array(aHmac)).map(b => b.toString(16).padStart(2, '0')).join('');
  const bHex = Array.from(new Uint8Array(bHmac)).map(b => b.toString(16).padStart(2, '0')).join('');
  return aHex === bHex;
}

async function requireInternalKey(request: IRequest, env: Env): Promise<Response | null> {
  const key = request.headers.get('X-Internal-Key');
  if (!env.INTERNAL_KEY || !key) {
    return fail('UNAUTHORIZED', 'Unauthorized', 401);
  }
  const match = await timingSafeSecretMatch(key, env.INTERNAL_KEY, 'internal');
  if (!match) return fail('UNAUTHORIZED', 'Unauthorized', 401);
  return null;
}

export const adminRouter = Router();

// ============= ADMIN: Tier Management (Owner only) =============

adminRouter.put('/v1/admin/accounts/:accountId/tier', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  if (ctx.tier !== 'owner') return fail('FORBIDDEN', 'Owner tier required', 403);

  const body = await request.json() as { tier?: string };
  const validTiers = ['free', 'pro', 'enterprise', 'owner'];
  if (!body.tier || !validTiers.includes(body.tier)) {
    return fail('BAD_REQUEST', `tier must be one of: ${validTiers.join(', ')}`, 400);
  }

  const updated = await getServices(env).auth.updateAccountTier(
    String(request.params?.accountId),
    body.tier as 'free' | 'pro' | 'enterprise' | 'owner',
  );
  if (!updated) return fail('NOT_FOUND', 'Account not found', 404);
  return ok(updated);
}));

// ============= ADMIN: Password Auth (public — no API key needed) =============

adminRouter.post('/v1/admin/auth', withErrorBoundary(async (request: IRequest, env: Env) => {
  const corsHeaders = getCorsHeaders(request);

  // Rate limit — 5 attempts per IP per 15 minutes
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

  // Constant-time password comparison via HMAC
  const isValid = password && env.ADMIN_DASHBOARD_PASSWORD
    ? await timingSafeSecretMatch(password, env.ADMIN_DASHBOARD_PASSWORD, 'admin')
    : false;

  if (!isValid) {
    return new Response(JSON.stringify({ error: 'Invalid password' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Inline stats + trajectory queries (avoids self-referential fetch)
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
}));

// ============= ADMIN: Stats (Owner only) =============

adminRouter.get('/v1/admin/stats', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  if (ctx.tier !== 'owner') return fail('FORBIDDEN', 'Owner tier required', 403);

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

  return ok({
    total_accounts: totalAccountsRow?.count ?? 0,
    active_accounts: activeAccountsRow?.count ?? 0,
    accounts: (accountsResult.results || []).map(a => ({
      id: a.id, name: a.name, email: a.email, tier: a.tier, created_at: a.created_at,
      decision_count: a.decision_count, last_active: a.last_active,
    })),
    total_decisions: totalDecisionsRow?.count ?? 0,
    decisions_last_7d: decisions7dRow?.count ?? 0,
    decisions_last_30d: decisions30dRow?.count ?? 0,
  });
}));

// ============= ADMIN: Intelligence Trajectory (Owner only) =============

adminRouter.get('/v1/admin/trajectory', authRoute(async (_request: IRequest, env: Env, ctx: RequestContext) => {
  if (ctx.tier !== 'owner') return fail('FORBIDDEN', 'Owner tier required', 403);

  const accountsResult = await env.DB
    .prepare('SELECT id, name FROM accounts')
    .all<{ id: string; name: string }>();
  const accountMap = new Map<string, string>();
  for (const a of (accountsResult.results || [])) {
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

  const accounts = Array.from(accountTrajectories.entries()).map(([accountId, trajectory]) => ({
    account_id: accountId,
    name: accountMap.get(accountId) || accountId,
    trajectory,
  }));

  return ok({ accounts });
}));

// ============= INTERNAL: Onboarding Emails =============

adminRouter.post('/v1/internal/trigger-onboarding', withErrorBoundary(async (request: IRequest, env: Env) => {
  const authErr = await requireInternalKey(request, env);
  if (authErr) return authErr;

  const body = await request.json() as { account_id?: string };
  if (!body.account_id) return fail('BAD_REQUEST', 'account_id required', 400);

  const account = await env.DB
    .prepare('SELECT id, email, name FROM accounts WHERE id = ? LIMIT 1')
    .bind(body.account_id)
    .first<{ id: string; email: string; name: string }>();
  if (!account) return fail('NOT_FOUND', 'Account not found', 404);

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
  return ok({ sent: true, account_id: body.account_id });
}));

// ============= INTERNAL: 7-Day Check-in Emails =============

adminRouter.post('/v1/internal/send-checkins', withErrorBoundary(async (request: IRequest, env: Env) => {
  const authErr = await requireInternalKey(request, env);
  if (authErr) return authErr;

  const rlAllowed = await checkRateLimit(env.DB, 'internal_email:send-checkins', 1, 60 * 60 * 1000);
  if (!rlAllowed) return fail('RATE_LIMITED', 'Rate limited', 429);

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
    if (acct.top_type) statsLines.push(`<p style="margin:0 0 4px;font-size:14px;color:#999;">🏷️ Top type: <strong style="color:#fff;">${acct.top_type}</strong></p>`);
    if (acct.success_rate !== null) statsLines.push(`<p style="margin:0 0 4px;font-size:14px;color:#999;">✅ Success rate: <strong style="color:#fff;">${acct.success_rate}%</strong></p>`);

    const html = emailCard("7 days in — here's what Marrow learned about you", `
        <p style="margin:0 0 20px;font-size:14px;color:#999;line-height:1.6;">Here's your agent's progress so far:</p>
        <div style="background:#1a1a1a;padding:16px;border-radius:8px;margin:0 0 24px;">
          ${statsLines.join('\n          ')}
        </div>
        <a href="https://getmarrow.ai" style="display:inline-block;padding:10px 20px;background:#ffffff;color:#0a0a0a;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;">Keep going — your agent is just getting started →</a>
    `);

    const sent = await sendEmail(env, acct.email, "7 days in — here's what Marrow learned about you", html);
    if (sent) {
      sentCount++;
      await env.DB.prepare('UPDATE accounts SET checkin_sent_at = ? WHERE id = ?').bind(new Date().toISOString(), acct.id).run().catch(() => {});
    }
  }

  return ok({ sent: sentCount, total_eligible: (accounts.results || []).length });
}));

// ============= INTERNAL: Day 3 Nudge Email =============

adminRouter.post('/v1/internal/send-day3-nudge', withErrorBoundary(async (request: IRequest, env: Env) => {
  const authErr = await requireInternalKey(request, env);
  if (authErr) return authErr;

  const rlAllowed2 = await checkRateLimit(env.DB, 'internal_email:send-day3-nudge', 1, 60 * 60 * 1000);
  if (!rlAllowed2) return fail('RATE_LIMITED', 'Rate limited', 429);

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

  return ok({ sent: sentCount, eligible: eligibleAccounts.length });
}));

export default adminRouter;
