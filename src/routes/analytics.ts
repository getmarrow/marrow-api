import type { IRequest } from 'itty-router';
import {
  Router,
  type Env,
  type ImprovementResult,
  autoLogDecision,
  checkRateLimit,
  createServices,
  err,
  forwardToLegacy,
  getUrl,
  json,
  requireAuth,
  safelyAsync,
  type VelocityMetric,
} from './shared';

export const analyticsRouter = Router();

for (const [method, path] of [
  ['GET', '/v1/analytics'],
  ['GET', '/v1/analytics/agent'],
  ['GET', '/v1/analytics/system'],
  ['GET', '/v1/analytics/trending'],
  ['GET', '/v1/export'],
  ['GET', '/v1/search'],
  ['GET', '/v1/versions'],
  ['GET', '/v1/versions/current'],
  ['GET', '/v1/versions/:from/migration/:to'],
  ['POST', '/v1/snapshots'],
  ['GET', '/v1/snapshots'],
  ['GET', '/v1/snapshots/:id'],
  ['POST', '/v1/snapshots/:id/diff'],
  ['POST', '/v1/snapshots/:id/restore'],
  ['GET', '/v1/restore/status'],
  ['DELETE', '/v1/snapshots/:id'],
] as const) {
  analyticsRouter[method.toLowerCase() as 'get' | 'post' | 'delete'](path, (request: IRequest, env: Env) => forwardToLegacy(request, env));
}

analyticsRouter.get('/v1/dashboard', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult;

    safelyAsync(autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: '/v1/dashboard',
      statusCode: 200,
      tier: ctx.tier,
      sessionId: request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null,
    }), 'dashboard-auto-log');

    const rlAllowed = await checkRateLimit(env.DB, `dashboard:${ctx.account_id}`, 30, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const data = await createServices(env).dashboard().getDashboard(ctx.account_id);
    return json(data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('GET /v1/dashboard error:', msg);
    return err('Internal server error', 500);
  }
});

analyticsRouter.get('/v1/digest', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult;

    safelyAsync(autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: '/v1/digest',
      statusCode: 200,
      tier: ctx.tier,
      sessionId: request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null,
    }), 'digest-auto-log');

    const rlAllowed = await checkRateLimit(env.DB, `digest:${ctx.account_id}`, 30, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const url = getUrl(request);
    const period = parseInt(url.searchParams.get('period') || '7');
    const days = Math.min(Math.max(period, 1), 30);

    const services = createServices(env);
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
      services.dashboard().getDashboard(ctx.account_id),
      services.impact().getSavesCount(ctx.account_id),
      services.baseline().getAccountImprovement(ctx.account_id),
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
    const topRisks = topFailureTypes.map((f) => `${f.decision_type} has ${Math.round(f.failure_rate * 100)}% failure rate (${f.count} failures)`);

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

export default analyticsRouter;
