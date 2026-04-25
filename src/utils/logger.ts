/**
 * Structured logger for Cloudflare Workers.
 *
 * Emits JSON to stdout/stderr — Cloudflare Workers Observability ingests these
 * automatically and they become queryable in the CF dashboard (3-day retention
 * on the default plan, longer with Logpush).
 *
 * Use this instead of `console.log/error` for anything that benefits from
 * later querying (errors, metrics, audit events).
 */

type Level = 'info' | 'warn' | 'error' | 'debug';

interface LogContext {
  /** Route, e.g. 'POST /v1/agent/commit' */
  route?: string;
  /** Account that owns the request, when known */
  account_id?: string;
  /** Agent ID (from X-Marrow-Agent-Id header), when known */
  agent_id?: string;
  /** Request ID for correlation, when generated */
  request_id?: string;
  /** Component / service name */
  component?: string;
  /** Anything else — kept narrow to avoid PII drift */
  [key: string]: unknown;
}

interface LogEntry extends LogContext {
  level: Level;
  msg: string;
  ts: string;
  /** Error message + stack when level=error and an Error was passed */
  error_message?: string;
  error_stack?: string;
}

function emit(level: Level, msg: string, ctx: LogContext = {}, err?: unknown): void {
  const entry: LogEntry = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...ctx,
  };

  if (err) {
    if (err instanceof Error) {
      entry.error_message = err.message;
      entry.error_stack = err.stack;
    } else {
      entry.error_message = String(err);
    }
  }

  // Cloudflare Workers Observability captures stderr for error level.
  // For all levels, JSON-formatted stdout is what makes it queryable.
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (msg: string, ctx?: LogContext) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => emit('warn', msg, ctx),
  error: (msg: string, err?: unknown, ctx?: LogContext) => emit('error', msg, ctx, err),
  debug: (msg: string, ctx?: LogContext) => emit('debug', msg, ctx),
};

/**
 * Wrap an async handler so unhandled errors are logged with context before
 * being re-thrown. Used at the top level of the worker fetch handler.
 */
export async function withErrorLogging<T>(
  ctx: LogContext,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log.error('unhandled_error', err, ctx);
    throw err;
  }
}
