import { Router, type IRequest } from 'itty-router';
import type { Env, RequestContext } from '../types';
import { getServices } from '../lib/services';
import { ok, fail } from '../lib/response';
import { withAuth } from '../middleware/auth';
import { withErrorBoundary } from '../middleware/error-boundary';
import { checkRateLimit } from '../utils/rate-limit';
import { ValueReportInputError } from '../services/value-report.service';

function getUrl(request: IRequest): URL {
  return new URL(request.url);
}

function authRoute(handler: (request: IRequest, env: Env, ctx: RequestContext) => Promise<Response>): (request: IRequest, env: Env) => Promise<Response> {
  return withErrorBoundary(withAuth(async (request: IRequest, env: Env) => handler(request, env, request.ctx as RequestContext)));
}

const ALLOWED_ORIGINS = [
  'https://getmarrow.ai',
  'https://www.getmarrow.ai',
  'https://marrow-vercel-simple.vercel.app',
  'https://marrow-landing.pages.dev',
];

export const router = Router();

router.get('/v1/analytics', authRoute(async (_request: IRequest, env: Env, ctx: RequestContext) => {
  if (ctx.tier === 'free') return fail('FORBIDDEN', 'Analytics require Pro or Enterprise tier', 403);

  const analytics = getServices(env).analytics;
  const [result, healthScore] = await Promise.all([
    analytics.getAgentAnalytics(ctx.account_id),
    analytics.calculateHealthScore(ctx.account_id).catch(() => null),
  ]);
  const response: Record<string, unknown> = { ...result };
  if (healthScore) response.health_score = healthScore;
  return ok(response);
}));

router.get('/v1/analytics/agent', authRoute(async (_request: IRequest, env: Env, ctx: RequestContext) => {
  const result = await getServices(env).analytics.getAgentAnalytics(ctx.account_id);
  return ok(result);
}));

router.get('/v1/analytics/system', authRoute(async (_request: IRequest, env: Env) => {
  const result = await getServices(env).analytics.getSystemAnalytics();
  return ok(result);
}));

router.get('/v1/analytics/trending', authRoute(async (request: IRequest, env: Env) => {
  const url = getUrl(request);
  const result = await getServices(env).analytics.getTrendingTypes(parseInt(url.searchParams.get('limit') || '10'));
  return ok(result);
}));

router.get('/v1/analytics/value-report', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const rlAllowed = await checkRateLimit(env.DB, `value_report:${ctx.account_id}`, 30, 60 * 1000);
  if (!rlAllowed) return fail('RATE_LIMITED', 'Rate limited', 429);

  const url = getUrl(request);
  const period = Number(url.searchParams.get('period') || '7');
  try {
    const result = await getServices(env).valueReport.build(ctx.account_id, {
      periodDays: period,
      agentId: url.searchParams.get('agent_id'),
    });
    return ok(result);
  } catch (error) {
    if (error instanceof ValueReportInputError) {
      return fail('BAD_REQUEST', error.message, 400);
    }
    throw error;
  }
}));

router.get('/v1/analytics/agent-status', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const rlAllowed = await checkRateLimit(env.DB, `agent_status:${ctx.account_id}`, 30, 60 * 1000);
  if (!rlAllowed) return fail('RATE_LIMITED', 'Rate limited', 429);

  const url = getUrl(request);
  const period = Number(url.searchParams.get('period') || '7');
  try {
    const result = await getServices(env).valueReport.buildAgentStatus(ctx.account_id, {
      periodDays: period,
      agentId: url.searchParams.get('agent_id'),
    });
    return ok(result);
  } catch (error) {
    if (error instanceof ValueReportInputError) {
      return fail('BAD_REQUEST', error.message, 400);
    }
    throw error;
  }
}));

router.get('/v1/export', authRoute(async (_request: IRequest, env: Env, ctx: RequestContext) => {
  if (ctx.tier === 'free') return fail('FORBIDDEN', 'Export requires Pro or Enterprise tier', 403);

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
}));

router.get('/v1/search', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  if (ctx.tier === 'free') return fail('FORBIDDEN', 'Search requires Pro or Enterprise tier', 403);

  const url = getUrl(request);
  const rawQ = url.searchParams.get('q');
  if (!rawQ) return fail('BAD_REQUEST', 'q parameter required', 400);
  if (rawQ.length > 200) return fail('BAD_REQUEST', 'Search query max 200 characters', 400);

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

  return ok(results.results || []);
}));

router.get('/v1/safety/violations', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const result = await getServices(env).enterprise.getSafetyViolations(ctx.account_id, {
    severity: url.searchParams.get('severity') || undefined,
    limit: parseInt(url.searchParams.get('limit') || '50'),
  });
  return ok(result);
}));

router.post('/v1/safety/check', authRoute(async (request: IRequest, env: Env) => {
  const body = await request.json() as Record<string, unknown>;
  const result = getServices(env).enterprise.checkDecisionSafety(
    String(body.decision_type || ''),
    body.context as Record<string, unknown> || {},
    String(body.outcome || ''),
  );
  return ok(result);
}));

router.get('/v1/stream', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const url = getUrl(request);
  const format = url.searchParams.get('format') || 'sse';
  const decisionType = url.searchParams.get('decision_type') || 'all';
  if (format !== 'sse') return fail('BAD_REQUEST', 'Unsupported stream format. Use format=sse', 400);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const connectEvent = `event: connected\ndata: ${JSON.stringify({ decision_type: decisionType, timestamp: new Date().toISOString() })}\n\n`;
  await writer.write(encoder.encode(connectEvent));

  const recent = await getServices(env).decisions.listDecisions(ctx.account_id, {
    decision_type: decisionType !== 'all' ? decisionType : undefined,
    limit: 10,
  });

  for (const decision of recent) {
    const event = `event: decision_logged\ndata: ${JSON.stringify({ decision, timestamp: new Date().toISOString() })}\n\n`;
    await writer.write(encoder.encode(event));
  }

  const heartbeat = `event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`;
  await writer.write(encoder.encode(heartbeat));
  await writer.close();

  const origin = request.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': allowedOrigin,
    },
  });
}));

router.get('/v1/dashboard', authRoute(async (_request: IRequest, env: Env, ctx: RequestContext) => {
  const rlAllowed = await checkRateLimit(env.DB, `dashboard:${ctx.account_id}`, 30, 60 * 1000);
  if (!rlAllowed) return fail('RATE_LIMITED', 'Rate limited', 429);

  const data = await getServices(env).dashboard.getDashboard(ctx.account_id);
  return ok(data);
}));

router.get('/v1/digest', authRoute(async (request: IRequest, env: Env, ctx: RequestContext) => {
  const rlAllowed = await checkRateLimit(env.DB, `digest:${ctx.account_id}`, 30, 60 * 1000);
  if (!rlAllowed) return fail('RATE_LIMITED', 'Rate limited', 429);

  const services = getServices(env);
  const url = getUrl(request);
  const period = parseInt(url.searchParams.get('period') || '7');
  const days = Math.min(Math.max(period, 1), 30);

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
    services.dashboard.getDashboard(ctx.account_id),
    services.impact.getSavesCount(ctx.account_id),
    services.baseline.getAccountImprovement(ctx.account_id),
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
  const topFailureTypes = (dashboardData.top_failures as Array<{ decision_type: string; failure_rate: number; count: number }>) || [];
  const topRisks = topFailureTypes.map(f => `${f.decision_type} has ${Math.round(f.failure_rate * 100)}% failure rate (${f.count} failures)`);

  const wfStatus = dashboardData.workflow_status as { completed_this_week: number; stalled: number };
  const velocity = dashboardData.velocity || {
    attempts_per_success: { current: 0, previous: 0, delta_pct: 0, direction: 'stable' },
    time_to_success_seconds: { current: 0, previous: 0, delta_pct: 0, direction: 'stable' },
    drift_rate: { current: 0, previous: 0, delta_pct: 0, direction: 'stable' },
  };

  const improvement = improvementData || {
    status: 'onboarding',
    days_elapsed: 0,
    decisions_elapsed: 0,
    days_until_time_trigger: 7,
    decisions_until_volume_trigger: 20,
    reason: 'Baseline captures on day 7 or after 20 decisions, whichever comes first.',
  };

  const improvementSentence = (improvement as Record<string, unknown>).status === 'active'
    ? `Since onboarding ${(improvement as Record<string, unknown>).days_since_baseline} days ago, your agents are ${Math.abs(Number((improvement as Record<string, unknown>).time_to_success_seconds?.['delta_pct'] || 0))}% faster and make ${Math.abs(Number((improvement as Record<string, unknown>).attempts_per_success?.['delta_pct'] || 0))}% ${Number((improvement as Record<string, unknown>).attempts_per_success?.['delta_pct'] || 0) >= 0 ? 'more' : 'fewer'} attempts per success. That's ${(improvement as Record<string, unknown>).decisions_since_baseline} decisions of compounding.`
    : `Currently onboarding — baseline snapshot takes at day 7 or 20 decisions (whichever first). ${(improvement as Record<string, unknown>).days_until_time_trigger} days / ${(improvement as Record<string, unknown>).decisions_until_volume_trigger} decisions to go.`;

  const summary = `${totalDecisions} decisions this period, ${Math.round(currentRate * 100)}% success rate (${direction}). ${savesCount.thisWeek} failures prevented by pattern matching. Agents completed tasks in ${velocity.time_to_success_seconds.current}s median (${velocity.time_to_success_seconds.direction} vs prior), with ${velocity.attempts_per_success.current} attempts per success on average. ${improvementSentence}`;

  return ok({
    period: `${startDate} to ${endDate}`,
    summary,
    decisions: { total: totalDecisions, successful: successfulDecisions, failed: failedDecisions },
    success_rate: { current: currentRate, previous_period: previousRate, change, direction },
    saves: { count: savesCount.thisWeek, details: [] },
    velocity,
    top_improvements: [],
    top_risks: topRisks,
    workflows_completed: wfStatus.completed_this_week,
    workflows_stalled: wfStatus.stalled,
    improvement,
  });
}));

export default router;
