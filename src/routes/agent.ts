import { Router, type IRequest } from 'itty-router';
import type { ApiKeyScope, Env, RequestContext } from '../types';
import { AuthRateLimitError, AuthService, AuthServiceError } from '../services/auth.service';
import { DecisionService } from '../services/decision.service';
import { SnapshotService } from '../services/snapshot.service';
import { WorkflowService } from '../orchestrator';
import { OrgService } from '../services/org.service';
import { PiiService } from '../services/pii.service';
import { CollectiveService } from '../services/collective.service';
import { ImpactService } from '../services/impact.service';
import { NarrativeService } from '../services/narrative.service';
import { WorkflowDetectionService } from '../services/workflow-detection.service';
import { SessionService } from '../services/session.service';
import { NudgeService } from '../services/nudge.service';
import { EmailService } from '../services/email.service';
import { checkRateLimit } from '../utils/rate-limit';
import { PatternEngine } from '../pattern-engine';
import { autoLogDecision, classifyDecisionQuality } from '../middleware/auto-logger';
import { actionQualityWarning, isStrictQualityMode, validateActionQuality } from '../middleware/action-validator';
import { getDedupedResponse, storeDedupedResponse } from '../middleware/dedup-cache';
import { safely } from '../utils/safely';
import { getServices, type Services } from '../lib/services';

const MARROW_API_VERSION = '2026.03.29';
const MARROW_SDK_LATEST = '3.7.20';
const MARROW_MCP_LATEST = '3.9.21';
const MARROW_INSTALL_COMMAND = 'npx @getmarrow/install --yes';
const MARROW_DOCTOR_COMMAND = 'npx @getmarrow/install doctor';
const MARROW_MCP_SETUP_COMMAND = 'npx @getmarrow/mcp setup';
const MARROW_SDK_INSTALL_COMMAND = 'npm install @getmarrow/sdk';
const MARROW_SDK_RUNTIME_COMMAND = "const marrow = new MarrowClient(process.env.MARROW_API_KEY); const runtime = marrow.createPassiveRuntime(); runtime.install();";

function redactSensitiveText(value: string): string {
  return value
    .replace(/(\B--(?:password|pass|secret|api-key|apikey|token|auth|access-token|client-secret|private-key|key)=)([^\s"'`]+|"[^"]*"|'[^']*')/gi, '$1[REDACTED]')
    .replace(/(\B--(?:password|pass|secret|api-key|apikey|token|auth|access-token|client-secret|private-key|key)\s+)([^\s"'`]+|"[^"]*"|'[^']*')/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Token|ApiKey|API_KEY|MARROW_API_KEY|MARROW_KEY)\s+[\w.\-+/=]{12,}\b/gi, '$1 [REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:SECRET|TOKEN|API[_-]?KEY|CREDENTIAL|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]*)\s*[:=]\s*['"]?[^'"\s,;]{6,}/gi, '$1=[REDACTED]')
    .replace(/\bmrw_(?:live|test)_[A-Za-z0-9_\-]{8,}\b/g, '[REDACTED_MARROW_KEY]')
    .replace(/\bmrw_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Fa-f0-9]{16,}\b/gi, '[REDACTED_MARROW_KEY]')
    .replace(/\b(?:sk|pk|ghp|github_pat|npm|cfut)_[A-Za-z0-9_\-]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/([?&])([^=&#\s]*(?:code|token|secret|signature|sig|credential|password|session|auth|api[_-]?key|apikey|client[_-]?secret|(?:^|[-_])key|key(?:[-_]|$))[^=&#\s]*=)[^&#\s]*/gi, '$1$2[redacted]')
    .replace(/([?&](?:token|key|secret|password|auth|signature|sig|session)=)[^&#\s]*/gi, '$1[redacted]');
}

function redactSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[redacted-depth]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactSensitiveValue(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[key] = /(?:secret|token|api[_-]?key|password|credential|authorization|private[_-]?key)/i.test(key)
        ? '[redacted]'
        : redactSensitiveValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
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
  const body: { error: string; code?: string; details?: Record<string, string> } = { error, code: codeMap[status] || 'ERROR' };
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

function boundAgentIds(ctx: RequestContext): string[] | null {
  if (ctx.agent_ids && ctx.agent_ids.length > 0) return ctx.agent_ids;
  if (ctx.agent_id) return [ctx.agent_id];
  return null;
}

async function forbidForeignDecisionForBoundAgent(
  db: D1Database,
  ctx: RequestContext,
  decisionId: string,
): Promise<Response | null> {
  const bound = boundAgentIds(ctx);
  if (!bound) return null;
  const row = await db.prepare(`
    SELECT agent_id, session_id
    FROM decisions
    WHERE account_id = ? AND id = ?
    LIMIT 1
  `).bind(ctx.account_id, decisionId).first<{ agent_id: string | null; session_id: string | null }>();
  if (!row) return err('Decision not found or unauthorized', 404);
  if ((row.agent_id && bound.includes(row.agent_id)) || (row.session_id && bound.includes(row.session_id))) {
    return null;
  }
  return err('Agent-bound key cannot commit another agent decision', 403);
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
  if (path === '/v1/agent/status') return ['decisions:read'];
  if (path === '/v1/agent/runtime') return method === 'GET' ? ['decisions:read'] : ['decisions:read', 'decisions:write'];
  if (path === '/v1/workflow/gate' || path === '/v1/workflows/gate') return ['decisions:write'];
  if (path === '/v1/agent/think' || path === '/v1/agent/commit' || path === '/v1/agent/nudge' || path.startsWith('/v1/decisions') || path.startsWith('/decisions')) {
    return method === 'GET' ? ['decisions:read'] : ['decisions:write'];
  }
  if (path.startsWith('/v1/patterns')) return ['patterns:read'];
  if (path.startsWith('/v1/webhooks')) return ['webhooks:manage'];
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return 'full';
  return 'full';
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

function getSvc(env: Env): Services { return getServices(env); }

async function requireAuth(request: IRequest, env: Env): Promise<RequestContext | Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    return err('Unauthorized', 401);
  }

  try {
    const authService = getSvc(env).auth;
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

async function autoSnapshotIfNeeded(db: D1Database, accountId: string, encryptionKey?: string): Promise<void> {
  try {
    const snapshotService = new SnapshotService(db, encryptionKey);
    const decisionService = new DecisionService(db);
    const lastSnapshotRow = await db
      .prepare('SELECT created_at FROM snapshots WHERE account_id = ? ORDER BY created_at DESC LIMIT 1')
      .bind(accountId)
      .first<{ created_at: string }>();
    if (lastSnapshotRow?.created_at) {
      const lastTime = new Date(lastSnapshotRow.created_at).getTime();
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      if (lastTime > oneHourAgo) return;
    }

    const snapshots = await snapshotService.listSnapshots(accountId, 1);
    const lastSnapshotTime = snapshots.length > 0 ? snapshots[0].created_at : null;
    const decisionsSinceSnapshot = await decisionService.getDecisionCount(accountId, lastSnapshotTime || undefined);

    if (decisionsSinceSnapshot >= 10) {
      await snapshotService.createSnapshot(accountId, `auto-snapshot-${new Date().toISOString()}`, ['auto']);
    }
  } catch (_e) {
    // best effort
  }
}

export const router = Router();

router.post('/v1/agent/think', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const reqSessionId = request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null;

    let reqAgentId: string | null = ctx.agent_id || null;
    const headerAgentId = request.headers.get('X-Marrow-Agent-Id');
    if (headerAgentId && /^[a-f0-9-]{36}$/.test(headerAgentId)) {
      const agentCheck = await env.DB
        .prepare("SELECT id FROM agents WHERE id = ? AND account_id = ? AND status != 'archived' LIMIT 1")
        .bind(headerAgentId, ctx.account_id)
        .first<{ id: string }>();
      if (agentCheck) reqAgentId = agentCheck.id;
    }

    const body = await request.json() as Record<string, unknown>;
    if (!body.action || typeof body.action !== 'string' || body.action.length > 1000) {
      return err('action is required and must be under 1000 characters', 400);
    }

    const action = String(body.action);
    const type = String(body.type || 'general');
    if (type.length > 50) return err('type max 50 characters', 400);
    let visibility = body.visibility ? String(body.visibility) as 'private' | 'shared' | 'hive' | 'team' : undefined;

    const qualityValidation = validateActionQuality(action);
    const strictQualityMode = isStrictQualityMode(env, ctx);
    if (!qualityValidation.valid && strictQualityMode) {
      return actionQualityError(qualityValidation);
    }
    const actionQuality = qualityValidation.valid
      ? classifyDecisionQuality(action)
      : { quality: 'trivial' as const, filtered: true, reason: 'trivial_action' as const };

    const piiService = getSvc(env).pii;
    const strippedAction = piiService.stripString(action);
    const sanitized = strippedAction !== action;

    const previousDecisionId = body.previous_decision_id ? String(body.previous_decision_id) : null;
    const previousSuccess = body.previous_success !== undefined ? Boolean(body.previous_success) : null;
    const previousOutcome = body.previous_outcome ? String(body.previous_outcome) : null;
    if (previousOutcome && previousOutcome.length > 2000) return err('previous_outcome max 2000 characters', 400);
    if (previousOutcome) {
      const previousOutcomeQuality = validateActionQuality(previousOutcome);
      if (!previousOutcomeQuality.valid && strictQualityMode) {
        return actionQualityError(previousOutcomeQuality);
      }
    }
    const previousCausedBy = body.previous_caused_by ? String(body.previous_caused_by) : null;

    const dedupActorKey = `${ctx.account_id}:${reqAgentId || reqSessionId || ctx.api_key_id || 'account'}`;
    const dedupFingerprint = `${type}:${action}`;
    const canDedupThink = !previousDecisionId && previousSuccess === null && previousOutcome === null && !previousCausedBy;
    if (canDedupThink) {
      const cached = getDedupedResponse<Record<string, unknown>>('think', dedupActorKey, dedupFingerprint);
      if (cached) {
        return json({ ...cached, deduped: true });
      }
    }

    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: new URL(request.url).pathname,
      statusCode: 200,
      tier: ctx.tier,
      sessionId: reqSessionId,
      body,
    }).catch(() => {});

    const workflow = new WorkflowService(env.DB, env.AI);
    let previousCommitted = false;
    let insight: string | null = null;
    let updatedSuccessRate: number | null = null;

    if (previousDecisionId && previousOutcome !== null && previousSuccess !== null) {
      try {
        const scopedDecisionError = await forbidForeignDecisionForBoundAgent(env.DB, ctx, previousDecisionId);
        if (scopedDecisionError) return scopedDecisionError;
        const commitResult = await workflow.after(
          {
            decision_id: previousDecisionId,
            success: previousSuccess,
            outcome: previousOutcome,
            related_decision_id: previousCausedBy ?? undefined,
            agent_id: reqAgentId ?? undefined,
          },
          ctx.account_id
        );
        previousCommitted = true;
        updatedSuccessRate = commitResult.new_success_rate ?? null;

        const signals = commitResult.hive_signals || [];
        if (signals.length > 0 && previousSuccess) {
          insight = `Pattern detected: ${signals[0]?.type || signals[0]?.decision_type || 'recurring success'} trending in hive`;
        }
      } catch (_commitErr) {
        console.error('auto-commit of previous session failed:', _commitErr);
      }
    }

    autoSnapshotIfNeeded(env.DB, ctx.account_id, env.ENCRYPTION_KEY).catch(() => {});

    let orgPiiStripTeam = false;
    if (ctx.tier === 'enterprise') {
      const orgSvc = getSvc(env).org;
      const org = await orgSvc.getOrgForAccount(ctx.account_id);
      if (org) {
        orgPiiStripTeam = !!org.pii_strip_team;
        if (!body.visibility && org.default_visibility) {
          visibility = org.default_visibility as 'private' | 'shared' | 'hive' | 'team';
        }
      }
    }

    const result = await workflow.before(
      {
        decision_type: type,
        action,
        description: action,
        visibility,
        session_id: reqSessionId,
        agent_id: reqAgentId,
        quality: actionQuality.quality,
      },
      ctx.account_id,
      ctx.tier,
      orgPiiStripTeam
    );

    if (reqAgentId) {
      env.DB.prepare("UPDATE agents SET last_active_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND account_id = ?")
        .bind(reqAgentId, ctx.account_id).run().catch(() => {});
    }

    const patternEngine = new PatternEngine(env.DB, env.AI);
    const engineResult = actionQuality.filtered
      ? { insights: [], clusterId: null }
      : await patternEngine.analyze(ctx.account_id, action, type, result.decision_id).catch(() => ({ insights: [], clusterId: null }));

    const streamUrl = `/v1/stream?decision_type=${encodeURIComponent(type)}&format=sse`;
    const successRate = updatedSuccessRate !== null ? updatedSuccessRate : (result.current_success_rate ?? 0.75);

    const mappedPatterns = (result.patterns || []).map((p: Record<string, unknown>) => ({
      pattern_id: p.pattern_signature || p.id || null,
      decision_type: p.decision_type || type,
      frequency: typeof p.frequency === 'number' ? p.frequency : 1,
      confidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
      first_seen: p.first_seen || null,
      last_seen: p.last_seen || null,
    }));

    const actionableInsights = [...(engineResult.insights || [])];
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

    if (!insight) {
      const criticalInsight = actionableInsights.find(i => i.severity === 'critical');
      const warningInsight = actionableInsights.find(i => i.severity === 'warning');
      const anyInsight = actionableInsights[0];
      const primaryInsight = criticalInsight || warningInsight || anyInsight;
      if (primaryInsight) insight = primaryInsight.summary;
    }

    if (env.RESEND_API_KEY) {
      env.DB
        .prepare('SELECT first_think_at, email FROM accounts WHERE id = ? LIMIT 1')
        .bind(ctx.account_id)
        .first<{ first_think_at: string | null; email: string }>()
        .then(async (acct) => {
          if (acct && !acct.first_think_at) {
            const ts = new Date().toISOString();
            const updateResult = await env.DB
              .prepare('UPDATE accounts SET first_think_at = ? WHERE id = ? AND first_think_at IS NULL')
              .bind(ts, ctx.account_id)
              .run();
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

    let upgradeHint: Record<string, unknown> | null = null;
    if (ctx.tier === 'free') {
      try {
        const decisionService = getSvc(env).decisions;
        const count = await decisionService.getDecisionCount(ctx.account_id);
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
        // non-fatal
      }
    }

    const responseWarnings = (!qualityValidation.valid && !strictQualityMode)
      ? [actionQualityWarning(qualityValidation)]
      : (result.warnings || []);

    const response: Record<string, unknown> = {
      decision_id: result.decision_id,
      sanitized,
      warnings: responseWarnings,
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
        risk_score: result.risk_score,
        velocity: 0,
        insight,
        insights: actionableInsights,
        cluster_id: engineResult.clusterId,
      },
      stream_url: streamUrl,
    };

    if (actionQuality.filtered) {
      response.filtered = true;
      response.reason = actionQuality.reason;
      response.quality = 'trivial';
    }

    try {
      const decisionService = getSvc(env).decisions;
      const count = await decisionService.getDecisionCount(ctx.account_id);
      let onboardingHint: string | null = null;
      if (count <= 3) {
        onboardingHint = 'Welcome to Marrow! Log decisions with think/commit to build your intelligence base.';
      } else if (count <= 10) {
        onboardingHint = `You have logged ${count} decisions. After 10, personalized pattern matching begins.`;
      } else if (count <= 50) {
        onboardingHint = 'Pattern matching active. After 50 decisions, workflow detection begins.';
      }
      if (onboardingHint) response.onboarding_hint = onboardingHint;
    } catch (_e) {}

    try {
      const sessionId = reqSessionId || ctx.account_id;
      const teamRows = await env.DB.prepare(`
        SELECT context, outcome, outcome_success, created_at, decision_type, session_id
        FROM decisions
        WHERE account_id = ? AND session_id IS NOT NULL AND session_id != ?
          AND decision_type NOT LIKE 'post_%'
          AND created_at > datetime('now', '-24 hours')
        ORDER BY created_at DESC LIMIT 5
      `).bind(ctx.account_id, sessionId).all<{
        context: string; outcome: string; outcome_success: number | null;
        created_at: string; decision_type: string; session_id: string;
      }>();
      if (teamRows.results && teamRows.results.length > 0) {
        const pii = getSvc(env).pii;
        const teamContext = (teamRows.results || []).map(r => {
          let actionText = r.decision_type;
          try {
            const parsed = JSON.parse(r.context || '{}');
            if (typeof parsed.action === 'string') actionText = parsed.action;
            else if (typeof parsed.description === 'string') actionText = parsed.description;
          } catch {}
          const strippedTeamAction = pii.stripString(actionText);
          const strippedOutcome = pii.stripString(r.outcome || '');
          const hoursAgo = Math.round((Date.now() - new Date(r.created_at).getTime()) / 3600000);
          return {
            agent: r.decision_type,
            action: strippedTeamAction.slice(0, 100),
            outcome: strippedOutcome.slice(0, 100),
            when: hoursAgo <= 1 ? '1 hour ago' : `${hoursAgo} hours ago`,
          };
        });
        (response.intelligence as Record<string, unknown>).team_context = teamContext;
      }
    } catch (_e) {}

    try {
      const collective = getSvc(env).collective;
      const collectiveInsight = await collective.getCollectiveInsight(type);
      if (collectiveInsight) {
        (response.intelligence as Record<string, unknown>).collective = collectiveInsight;
      }
    } catch (_e) {}

    if (actionableInsights.some(i => i.severity === 'critical')) {
      const impact = getSvc(env).impact;
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

    const intel = (response.intelligence as Record<string, unknown> | undefined) || {};
    const warnings_count = Array.isArray(response.warnings) ? response.warnings.length : 0;
    const loop_warnings_count = Array.isArray((response as Record<string, unknown>).loop_warnings) ? ((response as Record<string, unknown>).loop_warnings as unknown[]).length : 0;
    const hive_patterns = typeof intel.patterns_count === 'number' ? intel.patterns_count : 0;
    const similar_decisions = typeof intel.similar_count === 'number' ? intel.similar_count : 0;
    const templates_available = Array.isArray(intel.templates) ? intel.templates.length : 0;
    const has_collective_insight = typeof intel.insight === 'string' && (intel.insight as string).length > 0;
    const collective_intelligence = (intel.collective && typeof intel.collective === 'object') ? intel.collective : null;
    const team_context = (intel.team_context && typeof intel.team_context === 'object') ? intel.team_context : null;

    response.marrow_contributed = {
      warnings_consulted: warnings_count,
      hive_patterns_surfaced: hive_patterns,
      similar_decisions_found: similar_decisions,
      workflow_templates_available: templates_available,
      loop_detected: loop_warnings_count > 0,
      collective_intelligence: collective_intelligence ? true : false,
      team_context_present: team_context ? true : false,
      has_signal: warnings_count > 0 || hive_patterns > 0 || similar_decisions > 0
        || templates_available > 0 || loop_warnings_count > 0
        || has_collective_insight,
    };

    const clientSdkVersion = request.headers.get('X-SDK-Version');
    const sdkUpdateAvailable = clientSdkVersion && clientSdkVersion !== MARROW_SDK_LATEST
      ? { latest: MARROW_SDK_LATEST, current: clientSdkVersion, message: `Update available: npm install @getmarrow/sdk@${MARROW_SDK_LATEST}` }
      : undefined;
    if (sdkUpdateAvailable) response.sdk_update = sdkUpdateAvailable;

    if (canDedupThink) {
      storeDedupedResponse('think', dedupActorKey, dedupFingerprint, response);
    }

    checkRateLimit(env.DB, 'learn_templates_throttle', 1, 15 * 60 * 1000).then(allowed => {
      if (allowed) {
        const patAuto = getSvc(env).patterns;
        patAuto.learnTemplates().catch((e: unknown) => console.error('[auto-learn think]', e instanceof Error ? e.message : e));
      }
    }).catch(() => {});

    return json(response);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('POST /v1/agent/think error:', msg);
    return err('Failed to gather intelligence', 500);
  }
});

router.get('/v1/agent/patterns', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: new URL(request.url).pathname,
      statusCode: 200,
      tier: ctx.tier,
    }).catch(() => {});

    const url = getUrl(request);
    const typeFilter = url.searchParams.get('type') || null;
    const rawLimit = parseInt(url.searchParams.get('limit') || '20');
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 20 : Math.min(rawLimit, 100);
    const db = env.DB;
    const accountId = ctx.account_id;

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
      trend: 'stable' as string,
    }));

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

router.get('/v1/agent/suggestions', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    autoLogDecision({ db: env.DB, accountId: ctx.account_id, method: request.method, endpoint: '/v1/agent/suggestions', statusCode: 200, tier: ctx.tier, sessionId: request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null }).catch(() => {});

    const rlAllowed = await checkRateLimit(env.DB, `agent_suggestions:${ctx.account_id}`, 30, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const detection = getSvc(env).workflowDetection;
    const suggestions = await detection.getSuggestions(ctx.account_id);

    return json({ suggested_workflows: suggestions });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('GET /v1/agent/suggestions error:', msg);
    return err('Internal server error', 500);
  }
});

router.post('/v1/agent/commit', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    const commitSessionId = request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null;

    let commitAgentId: string | null = ctx.agent_id || null;
    const commitHeaderAgentId = request.headers.get('X-Marrow-Agent-Id');
    if (commitHeaderAgentId && /^[a-f0-9-]{36}$/.test(commitHeaderAgentId)) {
      const agentCheck = await env.DB
        .prepare("SELECT id FROM agents WHERE id = ? AND account_id = ? AND status != 'archived' LIMIT 1")
        .bind(commitHeaderAgentId, ctx.account_id)
        .first<{ id: string }>();
      if (agentCheck) commitAgentId = agentCheck.id;
    }

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

    const outcomeQuality = validateActionQuality(String(body.outcome));
    const strictQualityMode = isStrictQualityMode(env, ctx);
    if (!outcomeQuality.valid && strictQualityMode) {
      return actionQualityError(outcomeQuality);
    }

    const commitDedupActorKey = `${ctx.account_id}:${commitAgentId || commitSessionId || ctx.api_key_id || 'account'}`;
    const commitDedupFingerprint = `${String(body.decision_id)}:${Boolean(body.success)}:${String(body.outcome)}`;
    const cachedCommit = getDedupedResponse<Record<string, unknown>>('commit', commitDedupActorKey, commitDedupFingerprint);
    if (cachedCommit) {
      return json({ ...cachedCommit, decision_id: String(body.decision_id), deduped: true });
    }

    const scopedDecisionError = await forbidForeignDecisionForBoundAgent(env.DB, ctx, String(body.decision_id));
    if (scopedDecisionError) return scopedDecisionError;

    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: new URL(request.url).pathname,
      statusCode: 200,
      tier: ctx.tier,
      sessionId: commitSessionId,
      body,
    }).catch(() => {});

    const workflow = new WorkflowService(env.DB, env.AI);
    const result = await workflow.after(
      {
        decision_id: String(body.decision_id),
        success: Boolean(body.success),
        outcome: String(body.outcome),
        related_decision_id: body.caused_by ? String(body.caused_by) : undefined,
        agent_id: commitAgentId ?? undefined,
      },
      ctx.account_id
    );

    if (commitSessionId) {
      env.DB.prepare('UPDATE decisions SET session_id = ? WHERE id = ? AND account_id = ? AND session_id IS NULL')
        .bind(commitSessionId, String(body.decision_id), ctx.account_id).run().catch(() => {});
    }

    if (commitAgentId) {
      env.DB.prepare('UPDATE decisions SET agent_id = ? WHERE id = ? AND account_id = ? AND agent_id IS NULL')
        .bind(commitAgentId, String(body.decision_id), ctx.account_id).run().catch(() => {});
      env.DB.prepare("UPDATE agents SET last_active_at = datetime('now'), total_decisions = total_decisions + 1, updated_at = datetime('now') WHERE id = ? AND account_id = ?")
        .bind(commitAgentId, ctx.account_id).run().catch(() => {});
    }

    if (Boolean(body.success)) {
      const impact = getSvc(env).impact;
      await impact.confirmSave(ctx.account_id, String(body.decision_id), true).catch(() => {});
    }

    const narrative = await getSvc(env).narrative
      .getNarrativeForCommit(ctx.account_id, commitAgentId ?? undefined)
      .catch(() => null);

    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM decisions WHERE account_id = ? AND outcome_recorded_at IS NOT NULL`
    )
      .bind(ctx.account_id)
      .first<{ c: number }>()
      .then(async (countRow) => {
        const totalCommits = countRow?.c || 0;
        if (totalCommits !== 100) return;

        const baseline = await getSvc(env).baseline.getAccountImprovement(ctx.account_id).catch(() => null);
        if (!baseline || baseline.status !== 'active') return;

        const rawDelta = baseline.time_to_success_seconds.delta_pct;
        if (rawDelta >= 0) return;

        const improvement_pct = Math.abs(Math.round(rawDelta * 10) / 10);

        const account = await env.DB
          .prepare('SELECT email FROM accounts WHERE id = ? LIMIT 1')
          .bind(ctx.account_id)
          .first<{ email: string }>();
        if (!account?.email) return;

        const emailService = getSvc(env).email;
        await emailService.sendTemplate(ctx.account_id, account.email, 'milestone_100', {
          email: account.email,
          improvement_pct,
          decisions_count: totalCommits,
        });
      })
      .catch(() => {});

    const committedDecision = await env.DB
      .prepare(
        `SELECT cluster_id, related_decision_id FROM decisions WHERE id = ? AND account_id = ? LIMIT 1`
      )
      .bind(String(body.decision_id), ctx.account_id)
      .first<{ cluster_id: string | null; related_decision_id: string | null }>()
      .catch(() => null);

    const pattern_reused = Boolean(committedDecision?.cluster_id);
    const linked_to_prior = Boolean(committedDecision?.related_decision_id);

    let warning_avoided = false;
    if (Boolean(body.success)) {
      const saveRow = await env.DB
        .prepare(
          `SELECT id FROM saves WHERE account_id = ? AND decision_id = ? AND confirmed_save = 1 LIMIT 1`
        )
        .bind(ctx.account_id, String(body.decision_id))
        .first<{ id: string }>()
        .catch(() => null);
      warning_avoided = Boolean(saveRow);
    }

    let risk_score: number | null = null;
    try {
      const decision = await env.DB
        .prepare('SELECT decision_type FROM decisions WHERE id = ? AND account_id = ? LIMIT 1')
        .bind(String(body.decision_id), ctx.account_id)
        .first<{ decision_type: string }>();
      if (decision) {
        const patterns = getSvc(env).patterns;
        const { risk_score: rs } = await patterns.predictSimilarDecisions(
          { action: String(body.outcome) }, decision.decision_type, 5
        );
        risk_score = rs;
      }
    } catch (_e) {}

    const marrow_contributed = {
      success: Boolean(body.success),
      pattern_reused,
      linked_to_prior_decision: linked_to_prior,
      warning_avoided,
      has_signal: pattern_reused || warning_avoided || linked_to_prior,
    };

    checkRateLimit(env.DB, 'learn_templates_throttle', 1, 15 * 60 * 1000).then(allowed => {
      if (allowed) {
        const patLearn = getSvc(env).patterns;
        patLearn.learnTemplates().catch((e: unknown) => console.error('[auto-learn commit]', e instanceof Error ? e.message : e));
      }
    }).catch(() => {});

    const response: Record<string, unknown> = {
      committed: true,
      success_rate: result.new_success_rate ?? 0.75,
      insight: null,
      narrative,
      risk_score,
      marrow_contributed,
    };

    if (!outcomeQuality.valid && !strictQualityMode) {
      response.warnings = [actionQualityWarning(outcomeQuality)];
    }

    storeDedupedResponse('commit', commitDedupActorKey, commitDedupFingerprint, response);

    return json(response);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('POST /v1/agent/commit error:', msg);
    return err('Failed to commit decision', 500);
  }
});

router.post('/v1/agent/session/end', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;
    autoLogDecision({ db: env.DB, accountId: ctx.account_id, method: request.method, endpoint: '/v1/agent/session/end', statusCode: 200, tier: ctx.tier, sessionId: request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null }).catch(() => {});

    const rlAllowed = await checkRateLimit(env.DB, `session_end:${ctx.account_id}`, 10, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const body = await request.json() as Record<string, unknown>;
    const rawSessionId = body.session_id ? String(body.session_id).slice(0, 200) : null;
    const sessionId = rawSessionId ||
      request.headers.get('X-Marrow-Session-Id')?.slice(0, 200) || request.headers.get('X-Session-Id')?.slice(0, 200) ||
      ctx.account_id;
    const autoCommitOpen = body.auto_commit_open === true;

    const sessionService = getSvc(env).session;
    const result = await sessionService.endSession(sessionId, ctx.account_id, autoCommitOpen);

    if (autoCommitOpen && result.committed > 0) {
      console.warn('[session/end] auto-committed open decision on explicit caller request', { accountId: ctx.account_id, sessionId, openDecisionId: result.openDecisionId });
    }

    const summaryRow = await env.DB
      .prepare(
        `SELECT
           COUNT(*) AS decisions_total,
           SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) AS successes,
           SUM(CASE WHEN outcome_success = 0 THEN 1 ELSE 0 END) AS failures,
           SUM(CASE WHEN cluster_id IS NOT NULL THEN 1 ELSE 0 END) AS pattern_reuses
         FROM decisions
         WHERE account_id = ? AND session_id = ?`
      )
      .bind(ctx.account_id, sessionId)
      .first<{ decisions_total: number; successes: number; failures: number; pattern_reuses: number }>()
      .catch(() => null);

    const savesRow = await env.DB
      .prepare(
        `SELECT COUNT(*) AS saves
         FROM saves s
         JOIN decisions d ON d.id = s.decision_id
         WHERE d.account_id = ? AND d.session_id = ? AND s.confirmed_save = 1`
      )
      .bind(ctx.account_id, sessionId)
      .first<{ saves: number }>()
      .catch(() => null);

    const decisions_total = summaryRow?.decisions_total || 0;
    const successes = summaryRow?.successes || 0;
    const failures = summaryRow?.failures || 0;
    const pattern_reuses = summaryRow?.pattern_reuses || 0;
    const warnings_acted_on = savesRow?.saves || 0;

    const fragments: string[] = [];
    if (decisions_total > 0) fragments.push(`${decisions_total} decisions logged`);
    if (warnings_acted_on > 0) fragments.push(`${warnings_acted_on} retr${warnings_acted_on === 1 ? 'y' : 'ies'} avoided via Marrow warnings`);
    if (pattern_reuses > 0) fragments.push(`${pattern_reuses} pattern reuse${pattern_reuses === 1 ? '' : 's'} from your history`);
    const narrative = fragments.length > 0 ? fragments.join(', ') + '.' : null;

    const session_summary = {
      decisions_total,
      successes,
      failures,
      pattern_reuses,
      warnings_acted_on,
      narrative,
      has_signal: decisions_total > 0 && (warnings_acted_on > 0 || pattern_reuses > 0),
    };

    return json({
      session_id: sessionId,
      committed: result.committed,
      open_decision_id: result.openDecisionId,
      session_summary,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('POST /v1/agent/session/end error:', msg);
    return err('Internal server error', 500);
  }
});

router.get('/v1/agent/nudge', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const rlAllowed = await checkRateLimit(env.DB, `agent_nudge:${ctx.account_id}`, 30, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    autoLogDecision({ db: env.DB, accountId: ctx.account_id, method: request.method, endpoint: '/v1/agent/nudge', statusCode: 200, tier: ctx.tier }).catch((e) => { safely(() => console.warn('[auto-log]', e), 'auto-log'); });

    const nudge = getSvc(env).nudge;
    const result = await nudge.checkNudge(ctx.account_id);

    if (result.nudge && result.metrics) {
      const m = result.metrics;
      const impr = m.improvement;
      const impPct = impr ? Math.abs(Math.round((impr.time_to_success_seconds?.delta_pct || impr.attempts_per_success?.delta_pct || 0) * 10) / 10) : 0;
      const attPct = impr ? Math.abs(Math.round((impr.attempts_per_success?.delta_pct || 0) * 10) / 10) : 0;
      const drfPct = impr ? Math.abs(Math.round((impr.drift_rate?.delta_pct || 0) * 10) / 10) : 0;
      const sucRate = impr?.success_rate ? Math.round(impr.success_rate.current * 100) : 0;
      const acctId = ctx.account_id;
      const db = env.DB;
      const env2 = env;
      Promise.all([
        db.prepare("SELECT id FROM emails_sent WHERE account_id = ? AND template_name = ? LIMIT 1").bind(acctId, 'progress_report').first().catch(() => null),
        db.prepare('SELECT email FROM accounts WHERE id = ? LIMIT 1').bind(acctId).first().catch(() => null),
      ]).then(([sent, acct]) => {
        if (!sent && acct?.email) {
          const es = getSvc(env2).email;
          es.sendTemplate(acctId, acct.email, 'progress_report', {
            improvement_pct: impPct, attempts_pct: attPct, drift_pct: drfPct,
            pattern_reuse_pct: Math.round(100 - drfPct), success_rate: sucRate,
            saves_count: m.saves_count ?? 0, decisions_count: m.total_decisions,
          }).catch((e) => { safely(() => console.warn('[nudge-email]', e), 'nudge-email'); });
        }
      }).catch((e) => { safely(() => console.warn('[nudge-email-lookup]', e), 'nudge-email-lookup'); });
    }

    return json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('GET /v1/agent/nudge error:', msg);
    return err('Internal server error', 500);
  }
});

function parseRuntimeSurfaces(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((surface): surface is string => typeof surface === 'string')
    .map((surface) => surface.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12);
}

function inferRuntimeType(action: string, explicitType: unknown): string {
  if (typeof explicitType === 'string' && explicitType.trim()) return explicitType.trim().slice(0, 64);
  if (/\b(deploy|release|publish|npm|cloudflare|production|prod)\b/i.test(action)) return 'deploy';
  if (/\b(merge|pull request|pr|github)\b/i.test(action)) return 'merge';
  if (/\b(secret|token|key|credential|rotate|revoke)\b/i.test(action)) return 'security';
  return 'general';
}

function requiredProofFields(input: { action: string; type: string; surfaces: string[]; riskLevel: string }): string[] {
  const text = `${input.action} ${input.type} ${input.surfaces.join(' ')}`.toLowerCase();
  const fields = new Set(['summary', 'checks', 'outcome']);
  const highRisk = input.riskLevel === 'high' || /\b(production|prod|deploy|publish|merge|migration|secret|token|key|security|cloudflare|npm|github)\b/.test(text);
  if (highRisk) {
    ['blockers', 'commits_prs_shas', 'rollback_target', 'handoff_result_file'].forEach((field) => fields.add(field));
  }
  if (/\b(deploy|cloudflare|worker|pages|production|prod)\b/.test(text)) fields.add('deployment_and_smoke');
  if (/\b(npm|publish|package|registry)\b/.test(text)) fields.add('package_versions');
  if (/\b(secret|token|key|credential|security|audit|rotate|revoke)\b/.test(text)) fields.add('security_scan');
  return Array.from(fields);
}

function buildProofPack(input: {
  action: string;
  type: string;
  surfaces: string[];
  riskLevel: string;
  proof: Record<string, unknown>;
}) {
  const fields = requiredProofFields(input);
  const missing = fields.filter((field) => {
    const value = input.proof[field];
    if (Array.isArray(value)) return value.length === 0;
    return value === undefined || value === null || String(value).trim() === '';
  });
  const required = fields.length > 3 || input.riskLevel === 'high';
  return {
    required,
    enforced: required,
    fields,
    missing,
    complete: missing.length === 0,
    commit_endpoint: '/v1/agent/commit',
    rule: required
      ? 'Do not mark this action complete until every required proof field is present and the outcome is committed.'
      : 'Commit a concise outcome when the action completes.',
  };
}

function scopedDecisionWhere(ctx: RequestContext): { clause: string; params: string[] } {
  const bound = boundAgentIds(ctx);
  if (!bound || bound.length === 0) return { clause: '', params: [] };
  const parts: string[] = [];
  const params: string[] = [];
  for (const id of bound) {
    parts.push('agent_id = ?');
    params.push(id);
    parts.push('session_id = ?');
    params.push(id);
  }
  return { clause: ` AND (${parts.join(' OR ')})`, params };
}

async function buildAgentStatusPayload(env: Env, ctx: RequestContext) {
  const scope = scopedDecisionWhere(ctx);
  const cutoff24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [row, allRow, firstEventRow, lastEventRow, recentRow, recentOutcomeRow] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as succ,
             SUM(CASE WHEN outcome_success = 0 THEN 1 ELSE 0 END) as fail
      FROM decisions
      WHERE account_id = ? AND outcome_success IS NOT NULL${scope.clause}
    `).bind(ctx.account_id, ...scope.params).first<{ total: number; succ: number; fail: number }>(),
    env.DB.prepare(`SELECT COUNT(*) as total FROM decisions WHERE account_id = ?${scope.clause}`).bind(ctx.account_id, ...scope.params).first<{ total: number }>(),
    env.DB.prepare(`SELECT created_at FROM decisions WHERE account_id = ?${scope.clause} ORDER BY created_at ASC LIMIT 1`).bind(ctx.account_id, ...scope.params).first<{ created_at: string }>(),
    env.DB.prepare(`SELECT created_at FROM decisions WHERE account_id = ?${scope.clause} ORDER BY created_at DESC LIMIT 1`).bind(ctx.account_id, ...scope.params).first<{ created_at: string }>(),
    env.DB.prepare(`SELECT COUNT(*) as total FROM decisions WHERE account_id = ? AND created_at >= ?${scope.clause}`).bind(ctx.account_id, cutoff24h, ...scope.params).first<{ total: number }>(),
    env.DB.prepare(`
      SELECT COUNT(*) as total
      FROM decisions
      WHERE account_id = ? AND outcome_success IS NOT NULL AND created_at >= ?${scope.clause}
    `).bind(ctx.account_id, cutoff24h, ...scope.params).first<{ total: number }>(),
  ]);

  const allDecisions = allRow?.total || 0;
  const succ = row?.succ || 0;
  const fail = row?.fail || 0;
  const outcomes = row?.total || 0;
  const successRate = (succ + fail) > 0 ? succ / (succ + fail) : null;
  const outcomeCoverage = allDecisions > 0 ? outcomes / allDecisions : 0;
  const recentDecisions = recentRow?.total || 0;
  const recentOutcomeCount = recentOutcomeRow?.total || 0;
  const recentOutcomeCoverage = recentDecisions > 0 ? recentOutcomeCount / recentDecisions : 0;
  const outcomeClosureCoverage = recentDecisions > 0 ? recentOutcomeCoverage : outcomeCoverage;
  const firstEventAt = firstEventRow?.created_at || null;
  const lastEventAt = lastEventRow?.created_at || null;
  const enabled = allDecisions > 0;
  const missedHooks: string[] = [];
  if (!enabled) missedHooks.push('decisions');
  if (enabled && outcomeClosureCoverage < 0.35) missedHooks.push('outcomes');
  if (enabled && recentDecisions === 0) missedHooks.push('recent_activity');

  const fixCommands = missedHooks.includes('decisions')
    ? [MARROW_INSTALL_COMMAND, MARROW_DOCTOR_COMMAND]
    : missedHooks.includes('outcomes')
    ? [MARROW_INSTALL_COMMAND, MARROW_MCP_SETUP_COMMAND, MARROW_SDK_INSTALL_COMMAND]
    : missedHooks.includes('recent_activity')
    ? [MARROW_DOCTOR_COMMAND]
    : [];
  const recommendedFix = !enabled
    ? `Install MCP hooks or SDK passive runtime, then run a Marrow self-test. Run: ${MARROW_INSTALL_COMMAND}`
    : outcomeClosureCoverage < 0.35
    ? `Outcome capture is low. Missing hook: outcomes. Run: ${MARROW_INSTALL_COMMAND}. MCP-only fix: ${MARROW_MCP_SETUP_COMMAND}. SDK fix: install createPassiveRuntime() and wrap command/tool/deploy/publish calls.`
    : recentDecisions === 0
    ? `Marrow is configured but has no recent events. Run: ${MARROW_DOCTOR_COMMAND}, then verify the active agent has MARROW_API_KEY.`
    : null;
  const health = !enabled || missedHooks.length > 0 || fail > succ * 0.5 ? 'degraded' : 'healthy';
  const hookStatus = {
    decisions: {
      state: enabled ? 'detected' : 'missing',
      missing: !enabled,
      fix_command: MARROW_INSTALL_COMMAND,
      detail: enabled
        ? 'Marrow is receiving decision events.'
        : 'No decision events have been logged for this account or agent scope yet.',
    },
    outcomes: {
      state: !enabled ? 'unknown' : outcomeClosureCoverage >= 0.35 ? 'detected' : 'missing',
      missing: enabled && outcomeClosureCoverage < 0.35,
      coverage: outcomeClosureCoverage,
      historical_coverage: outcomeCoverage,
      recent_coverage_24h: recentOutcomeCoverage,
      fix_command: MARROW_INSTALL_COMMAND,
      sdk_fix_command: MARROW_SDK_INSTALL_COMMAND,
      sdk_fix_snippet: MARROW_SDK_RUNTIME_COMMAND,
      mcp_fix_command: MARROW_MCP_SETUP_COMMAND,
      detail: !enabled
        ? 'Outcome coverage is unknown until at least one decision is logged.'
        : outcomeClosureCoverage < 0.35
        ? 'Outcome closure is low. Enable PostToolUse hooks or SDK passive runtime wrappers so tool, command, deploy, and publish actions auto-commit success/failure.'
        : 'Outcomes are being captured for recent passive actions.',
    },
    recent_activity: {
      state: !enabled ? 'unknown' : recentDecisions > 0 ? 'detected' : 'missing',
      missing: enabled && recentDecisions === 0,
      fix_command: MARROW_DOCTOR_COMMAND,
      detail: enabled && recentDecisions === 0
        ? 'Marrow has history but no events in the last 24 hours for this account or agent scope.'
        : 'Recent activity is present or not applicable yet.',
    },
    tools: {
      state: outcomeCoverage > 0 ? 'detected' : 'unknown',
      missing: false,
      fix_command: MARROW_MCP_SETUP_COMMAND,
      detail: 'Tool capture is inferred from outcome-bearing passive events.',
    },
    commands: {
      state: outcomeCoverage > 0 ? 'detected' : 'unknown',
      missing: false,
      fix_command: MARROW_SDK_INSTALL_COMMAND,
      sdk_fix_snippet: MARROW_SDK_RUNTIME_COMMAND,
      detail: 'Command capture is available through SDK passive runtime command wrappers and MCP PostToolUse hooks.',
    },
    deploys: {
      state: 'unknown',
      missing: false,
      fix_command: MARROW_SDK_INSTALL_COMMAND,
      sdk_fix_snippet: MARROW_SDK_RUNTIME_COMMAND,
      detail: 'Deploy capture is available through runtime.deploy(), runtime.command(), or MCP PostToolUse hooks.',
    },
    publishes: {
      state: 'unknown',
      missing: false,
      fix_command: MARROW_SDK_INSTALL_COMMAND,
      sdk_fix_snippet: MARROW_SDK_RUNTIME_COMMAND,
      detail: 'Publish capture is available through runtime.publish(), runtime.command(), or MCP PostToolUse hooks.',
    },
  };
  const message = allDecisions === 0
    ? 'Marrow is reachable, but no passive decisions have been logged yet.'
    : allDecisions < 10
    ? `Marrow is active — ${allDecisions} decision${allDecisions === 1 ? '' : 's'} logged. Keep going for stronger pattern detection.`
    : `Marrow is active — ${allDecisions} decisions tracked. Outcome coverage: ${Math.round(outcomeCoverage * 100)}%.`;

  return {
    ok: true,
    enabled,
    health,
    message,
    has_memory: allDecisions > 0,
    low_history: allDecisions < 10,
    decision_count: allDecisions,
    outcome_count: outcomes,
    success_rate: successRate,
    first_event_at: firstEventAt,
    last_event_at: lastEventAt,
    recent_decisions_24h: recentDecisions,
    recent_outcome_count_24h: recentOutcomeCount,
    recent_outcome_coverage_24h: recentOutcomeCoverage,
    capture_coverage: {
      decisions: enabled,
      outcomes: outcomeCoverage,
      recent_outcomes: recentOutcomeCoverage,
      tools: outcomeCoverage > 0 ? 'detected' : 'unknown',
      commands: outcomeCoverage > 0 ? 'detected' : 'unknown',
      deploys: 'unknown',
      publishes: 'unknown',
    },
    missed_hooks: missedHooks,
    hook_status: hookStatus,
    recommended_fix: recommendedFix,
    fix_commands: fixCommands,
    next_action: fixCommands[0] || null,
    auto_outcome_closure: {
      enabled: enabled && outcomeClosureCoverage >= 0.35,
      required: true,
      state: !enabled ? 'inactive' : outcomeClosureCoverage >= 0.35 ? 'active' : 'needs_hook',
      coverage: outcomeClosureCoverage,
      historical_coverage: outcomeCoverage,
      recent_coverage_24h: recentOutcomeCoverage,
      recent_outcomes_24h: recentOutcomeCount,
      repair_command: MARROW_INSTALL_COMMAND,
      expectation: 'Every captured tool, command, deploy, and publish action should auto-commit success or failure through MCP PostToolUse hooks or SDK passive runtime wrappers.',
    },
    proof: {
      raw_data_exposed: false,
      scoped_to_bound_agent: Boolean(boundAgentIds(ctx)),
      last_event_at: lastEventAt,
      recent_decisions_24h: recentDecisions,
    },
  };
}

router.post('/v1/agent/runtime', async (request: IRequest, env: Env) => {
  try {
    const authResult = await requireAuth(request, env);
    if (authResult instanceof Response) return authResult;
    const ctx = authResult as RequestContext;

    const rlAllowed = await checkRateLimit(env.DB, `agent_runtime:${ctx.account_id}`, 60, 60 * 1000);
    if (!rlAllowed) return err('Rate limited', 429);

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const rawAction = typeof body.action === 'string' ? body.action.trim() : '';
    if (!rawAction) return err('action is required', 400);
    if (rawAction.length > 1000) return err('action must be under 1000 characters', 400);
    const action = redactSensitiveText(rawAction);
    const redactedContext = body.context && typeof body.context === 'object' && !Array.isArray(body.context)
      ? redactSensitiveValue(body.context) as Record<string, unknown>
      : undefined;
    const redactedProof = body.proof && typeof body.proof === 'object' && !Array.isArray(body.proof)
      ? redactSensitiveValue(body.proof) as Record<string, unknown>
      : {};

    const bound = boundAgentIds(ctx);
    const requestedAgentId = typeof body.agent_id === 'string' ? body.agent_id : null;
    if (bound && requestedAgentId && !bound.includes(requestedAgentId)) {
      return err('Agent-bound key cannot access another agent.', 403);
    }
    const agentId = requestedAgentId || bound?.[0] || ctx.agent_id || null;
    const sessionId = typeof body.session_id === 'string'
      ? body.session_id
      : request.headers.get('X-Marrow-Session-Id') || request.headers.get('X-Session-Id') || null;
    const surfaces = parseRuntimeSurfaces(body.surfaces);
    const type = inferRuntimeType(action, body.type);
    const role = typeof body.role === 'string' ? body.role : type === 'deploy' ? 'deploy' : 'agent';
    const services = getSvc(env);

    const status = await buildAgentStatusPayload(env, ctx);
    const decisionBrief = await services.valueReport.buildDecisionBrief(ctx.account_id, {
      action,
      type,
      role,
      periodDays: typeof body.period === 'number' || typeof body.period === 'string' ? Number(body.period) : undefined,
      agentId,
      sessionId,
      surfaces,
    });
    const riskLevel = decisionBrief.risk?.level || 'low';
    const proofPack = buildProofPack({
      action,
      type,
      surfaces,
      riskLevel,
      proof: redactedProof,
    });
    const canReadShared = await services.fleetLearning.canReadSharedFleet(ctx.account_id, bound || undefined);
    const [lessons, deploymentMemory, templateSuggestion] = await Promise.all([
      services.fleetLearning.listLessons(ctx.account_id, {
        query: action,
        agent_id: canReadShared ? null : bound?.[0],
        access_agent_ids: bound || undefined,
        limit: 5,
      }).catch(() => []),
      riskLevel !== 'low'
        ? services.fleetLearning.listDeploymentMemories(ctx.account_id, {
          agent_id: canReadShared ? null : bound?.[0],
          access_agent_ids: bound || undefined,
          limit: 3,
        }).catch(() => [])
        : Promise.resolve([]),
      services.templates.detectTemplate({
        action,
        type,
        surfaces,
        risk_level: riskLevel,
        context: redactedContext,
        limit: 3,
      }).catch((error: unknown) => ({
        matched: false,
        error: error instanceof Error ? error.message : 'template detection failed',
      })),
    ]);

    const proofIncomplete = proofPack.required && !proofPack.complete;
    const riskGate = {
      allow: riskLevel !== 'high' && !proofIncomplete,
      decision: riskLevel === 'high' || proofIncomplete ? 'review_required' : riskLevel === 'medium' ? 'warn' : 'allow',
      risk_level: riskLevel,
      reasons: [
        ...decisionBrief.risk.reasons.map((reason) => ({ code: reason, severity: riskLevel, message: reason })),
        ...(proofIncomplete ? [{ code: 'proof_pack_incomplete', severity: 'high', message: 'Required proof pack fields are missing.' }] : []),
      ],
      policy: {
        mode: 'agent_runtime',
        side_effects: 'metadata_log_only',
      },
    };
    const topLesson = lessons[0] || null;
    const topPlaybook = deploymentMemory[0] || null;
    const beforeYouAct = topLesson
      ? `Before continuing, use prior lesson: ${topLesson.summary || topLesson.action_pattern || topLesson.id}`
      : topPlaybook
      ? `Before continuing, use deployment playbook: ${topPlaybook.release_id || topPlaybook.id}`
      : decisionBrief.next_actions[0] || null;
    const beforeYouActInjection = {
      required: Boolean(topLesson || topPlaybook || riskLevel !== 'low' || proofIncomplete),
      source: topLesson ? 'fleet_lesson' : topPlaybook ? 'deployment_memory' : proofIncomplete ? 'proof_pack' : riskLevel !== 'low' ? 'risk_gate' : 'decision_brief',
      message: beforeYouAct,
      must_use_before_action: Boolean(topLesson && topLesson.score >= 0.55) || riskLevel !== 'low' || proofIncomplete,
      lesson_id: topLesson?.id || null,
      lesson_score: topLesson?.score ?? null,
      action_pattern: topLesson?.action_pattern || null,
      outcome_success: topLesson?.outcome_success ?? null,
      playbook_id: topPlaybook?.id || null,
      risk_level: riskLevel,
    };
    const exactNextAction = (proofIncomplete ? `Collect proof fields: ${proofPack.missing.join(', ')}` : null)
      || status.next_action
      || beforeYouAct
      || 'Proceed, then commit the outcome.';

    if (topLesson) {
      services.fleetLearning.markLessonReused(ctx.account_id, topLesson.id, bound || undefined).catch(() => {});
    }

    autoLogDecision({
      db: env.DB,
      accountId: ctx.account_id,
      method: request.method,
      endpoint: '/v1/agent/runtime',
      statusCode: 200,
      tier: ctx.tier,
      sessionId,
    }).catch(() => {});

    return json({
      ok: true,
      action,
      agent_id: agentId,
      session_id: sessionId,
      status,
      decision_brief: decisionBrief,
      risk_gate: riskGate,
      relevant_lessons: lessons,
      deployment_playbooks: deploymentMemory,
      template_suggestion: templateSuggestion,
      proof_pack: proofPack,
      before_you_act: beforeYouAct,
      before_you_act_injection: beforeYouActInjection,
      exact_next_action: exactNextAction,
      auto_outcome_closure: status.auto_outcome_closure,
    });
  } catch (e: unknown) {
    console.error('POST /v1/agent/runtime error:', e);
    return err('Internal server error', 500);
  }
});

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

    return json(await buildAgentStatusPayload(env, ctx));
  } catch (e: unknown) {
    console.error('GET /v1/agent/status error:', e);
    return err('Internal server error', 500);
  }
});
