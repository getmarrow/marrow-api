import { classifyDecisionQuality, validateActionQuality } from './action-validator';

/**
 * Auto-Logging Middleware
 * 
 * Intercepts every authenticated API call and automatically logs it as a decision.
 * This ensures NO decision goes unrecorded — even if the agent forgets to call marrow_think/marrow_commit.
 * 
 * The whole point of Marrow: capture everything, compound intelligence, zero friction.
 */

interface AutoLogEntry {
  db: D1Database;
  accountId: string;
  method: string;
  endpoint: string;
  statusCode: number;
  body?: unknown;
  tier?: string;
  sessionId?: string | null;
}

export { classifyDecisionQuality };

/**
 * Auto-log an API call as a decision — non-blocking, fire-and-forget.
 * Never affects the response.
 */
export async function autoLogDecision(entry: AutoLogEntry): Promise<void> {
  try {
    const candidateAction = extractActionCandidate(entry.method, entry.endpoint, entry.body);
    if (!validateActionQuality(candidateAction).valid) {
      return;
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const decisionType = deriveDecisionType(entry.method, entry.endpoint);

    const context = buildAutoLogContext(entry);

    // If auth passed, request was valid — log as success (200). Actual status tracked in analytics.
    const statusCode = entry.statusCode > 0 ? entry.statusCode : 200;
    const outcome = `${entry.method} ${entry.endpoint} → ${statusCode}`;
    const confidence = 0.9;

    await entry.db
      .prepare(`
        INSERT INTO decisions (
          id, account_id, decision_type, context, outcome,
          confidence, visibility, context_compressed,
          context_hive, session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        entry.accountId,
        decisionType,
        JSON.stringify(context),
        outcome,
        confidence,
        'hive',
        1,
        null,
        entry.sessionId || null,
        now,
        now
      )
      .run();
  } catch (e) {
    // Non-critical — never log failures to avoid infinite loops
    console.error('[auto-log] Failed to log decision:', e);
  }
}

/**
 * Derive a human-readable decision type from the endpoint.
 */
function deriveDecisionType(method: string, endpoint: string): string {
  const path = endpoint.replace(/^\/v1\//, '').replace(/^\//, '').replace(/\//g, '_');
  return `${method.toLowerCase()}_${path || 'root'}`;
}

function extractActionCandidate(method: string, endpoint: string, body: unknown): string {
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    const candidates = [obj.action, obj.description, obj.query, obj.name]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
    if (candidates.length > 0) return candidates[0];
  }

  return `${method.toUpperCase()} ${endpoint}`;
}

/**
 * Summarize request body for logging (strip sensitive data, keep it short).
 */
function buildAutoLogContext(entry: AutoLogEntry): Record<string, unknown> {
  const context: Record<string, unknown> = {
    method: entry.method,
    endpoint: entry.endpoint,
    statusCode: entry.statusCode > 0 ? entry.statusCode : 200,
  };

  const action = extractMeaningfulBodyAction(entry.body);
  if (action) {
    context.action = action;
  }

  return context;
}

function extractMeaningfulBodyAction(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;

  const obj = body as Record<string, unknown>;
  const candidates = [obj.action, obj.description, obj.query, obj.name]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (validateActionQuality(candidate).valid) {
      return candidate.slice(0, 200);
    }
  }

  return undefined;
}
