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
}

/**
 * Auto-log an API call as a decision — non-blocking, fire-and-forget.
 * Never affects the response.
 */
export async function autoLogDecision(entry: AutoLogEntry): Promise<void> {
  try {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const decisionType = deriveDecisionType(entry.method, entry.endpoint);

    const context = {
      method: entry.method,
      endpoint: entry.endpoint,
      body: entry.body ? summarizeBody(entry.body) : undefined,
    };

    // If auth passed, request was valid — log as success (200). Actual status tracked in analytics.
    const statusCode = entry.statusCode > 0 ? entry.statusCode : 200;
    const outcome = `${entry.method} ${entry.endpoint} → ${statusCode}`;
    const confidence = 0.9;

    await entry.db
      .prepare(`
        INSERT INTO decisions (
          id, account_id, decision_type, context, outcome,
          confidence, visibility, context_compressed,
          context_hive, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        entry.accountId,
        decisionType,
        JSON.stringify(context),
        outcome,
        confidence,
        'hive',
        0,
        null,
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

/**
 * Summarize request body for logging (strip sensitive data, keep it short).
 */
function summarizeBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return { raw: String(body) };
  const summary: Record<string, unknown> = {};
  const obj = body as Record<string, unknown>;
  const safeFields = ['action', 'type', 'query', 'name', 'description', 'step', 'workflow_id', 'agent_id'];
  for (const field of safeFields) {
    if (obj[field] !== undefined) {
      summary[field] = typeof obj[field] === 'string' ? String(obj[field]).slice(0, 200) : obj[field];
    }
  }
  return Object.keys(summary).length > 0 ? summary : { body_type: typeof body };
}
